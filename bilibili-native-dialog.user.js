// ==UserScript==
// @name         bilibili类原生查看对话
// @namespace    https://github.com/nsdd/bilibili-native-dialog
// @version      0.5.6
// @author       luolisama
// @downloadURL  https://github.com/luolisama/bilibili-native-dialog/raw/refs/heads/main/bilibili-native-dialog.user.js?download=1
// @updateURL    https://github.com/luolisama/bilibili-native-dialog/raw/refs/heads/main/bilibili-native-dialog.user.js?download=1
// @description  在 B 站原生楼中楼操作栏中添加同风格的“查看对话”，并提供评论区式互动、表情和原生风格 @ 回复。
// @match        https://www.bilibili.com/*
// @match        https://bilibili.com/*
// @match        https://*.bilibili.com/*
// @grant        none
// @run-at       document-start
// @noframes
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    const CONFIG = Object.freeze({
        pageSize: 20,
        maxPages: 100,
        cacheTtlMs: 3 * 60 * 1000,
        scanDebounceMs: 180,
        scanIntervalMs: 5000,
        requestTimeoutMs: 15000,
        apiBase: 'https://api.bilibili.com',
        maxDialogCacheEntries: 24,
        maxPageMentionCandidates: 300
    });

    const COMMENT_TYPES = new Set(['1', '11', '12', '17']);

    const SELECTORS = Object.freeze({
        replyHost: [
            'bili-comment-reply-renderer',
            'bili-comment-sub-reply-renderer',
            'bili-comment-reply-item-renderer'
        ]
    });

    const state = {
        observedRoots: new WeakSet(),
        styledRoots: new WeakSet(),
        scanTimer: null,
        scanInterval: null,
        scanning: false,
        pendingScanNodes: new Set(),
        fullScanPending: false,
        routeKey: location.href,
        dialogCache: new Map(),
        activePanel: null,
        activeAbortController: null,
        interactionControllers: new Set(),
        emotePromise: null,
        followingPromise: null,
        wbiPromise: null,
        pageTargetPromise: null,
        pageMentionCandidates: new Map(),
        initialized: false
    };

    const GLOBAL_STYLE_ID = 'bdv-global-style';
    const LINK_CLASS = 'bdv-view-dialog';

    function isObject(value) {
        return value !== null && typeof value === 'object';
    }

    function safeString(value) {
        if (value === undefined || value === null) return '';
        return String(value).trim();
    }

    function firstString(...values) {
        for (const value of values) {
            const result = safeString(value);
            if (result) return result;
        }
        return '';
    }

    function readId(object, name) {
        if (!isObject(object)) return '';
        return firstString(object[`${name}_str`], object[name]);
    }

    function getRawDataCandidates(host) {
        const result = [];
        const seen = new Set();

        const add = (value) => {
            if (!isObject(value) || seen.has(value)) return;
            seen.add(value);
            result.push(value);
        };

        try {
            add(host.__data__);
            add(host.__data);
            add(host.data);
            add(host.commentData);
            add(host.replyData);
            add(host.comment);
            add(host.reply);
        } catch (_) {
            // Custom elements may expose throwing getters. A missing getter is non-fatal.
        }

        for (const value of [...result]) {
            add(value.reply);
            add(value.item);
            add(value.data);
            add(value.replyInfo);
        }

        const attrData = {
            rpid_str: firstString(
                host.getAttribute?.('data-rpid'),
                host.getAttribute?.('data-rpid-str'),
                host.getAttribute?.('rpid')
            ),
            root_str: firstString(
                host.getAttribute?.('data-root'),
                host.getAttribute?.('data-root-str'),
                host.getAttribute?.('root')
            ),
            parent_str: firstString(
                host.getAttribute?.('data-parent'),
                host.getAttribute?.('data-parent-str'),
                host.getAttribute?.('parent')
            ),
            dialog_str: firstString(
                host.getAttribute?.('data-dialog'),
                host.getAttribute?.('data-dialog-str'),
                host.getAttribute?.('dialog')
            ),
            oid: firstString(host.getAttribute?.('data-oid'), host.getAttribute?.('oid')),
            type: firstString(host.getAttribute?.('data-type'), host.getAttribute?.('type'))
        };

        if (Object.values(attrData).some(Boolean)) add(attrData);
        return result;
    }

    function getPageState() {
        try {
            return window.__INITIAL_STATE__ || null;
        } catch (_) {
            return null;
        }
    }

    function extractAidFromPageState() {
        const stateObject = getPageState();
        if (!isObject(stateObject)) return '';

        const direct = firstString(
            stateObject.aid,
            stateObject.videoData?.aid,
            stateObject.videoInfo?.aid,
            stateObject.detail?.aid
        );
        if (direct) return direct;

        return '';
    }

    function normalizeCommentType(value) {
        const type = safeString(value);
        return COMMENT_TYPES.has(type) ? type : '';
    }

    function requireCommentType(info) {
        const type = normalizeCommentType(info?.type);
        if (!type) throw new Error('无法识别当前页面的评论类型');
        return type;
    }

    function getPageContext() {
        const pathname = safeString(location.pathname);
        const hostname = safeString(location.hostname).toLowerCase();
        const params = new URLSearchParams(location.search);
        const stateObject = getPageState();
        const stateType = normalizeCommentType(firstString(
            stateObject?.comment_type,
            stateObject?.commentType,
            stateObject?.type,
            stateObject?.detail?.comment_type,
            stateObject?.detail?.type,
            stateObject?.detail?.item?.comment_type,
            stateObject?.detail?.item?.type,
            stateObject?.dynamic?.comment_type,
            stateObject?.dynamic?.type,
            stateObject?.opus?.type,
            stateObject?.opusDetail?.type,
            stateObject?.item?.type,
            stateObject?.data?.type
        ));
        const stateOid = firstString(
            stateObject?.comment_id,
            stateObject?.commentId,
            stateObject?.comment_oid,
            stateObject?.commentOid,
            stateObject?.oid,
            stateObject?.dynamic?.id,
            stateObject?.dynamic?.rid,
            stateObject?.dynamic?.dynamic_id,
            stateObject?.detail?.id,
            stateObject?.detail?.item?.id,
            stateObject?.opus?.id,
            stateObject?.opusDetail?.id,
            stateObject?.item?.id,
            stateObject?.data?.id
        );

        const videoMatch = pathname.match(/\/video\/(BV[a-zA-Z0-9]{10})/i);
        if (videoMatch) {
            return { type: '1', oid: extractAidFromPageState() };
        }

        const articleMatch = pathname.match(/\/read\/(?:cv)?(\d+)/i);
        if (articleMatch) return { type: '12', oid: articleMatch[1] };
        if (/\/read\/mobile(?:\/|$)/i.test(pathname)) {
            return { type: '12', oid: firstString(params.get('id'), params.get('cvid'), stateOid) };
        }

        const albumMatch = pathname.match(/\/album\/(\d+)/i);
        if (albumMatch) return { type: '11', oid: albumMatch[1] };

        const opusMatch = pathname.match(/\/opus\/(\d+)/i);
        if (opusMatch) return { type: stateType || '17', oid: opusMatch[1] };

        const dynamicMatch = pathname.match(/\/dynamic\/(\d+)/i);
        if (dynamicMatch) return { type: stateType || '17', oid: dynamicMatch[1] };
        if (hostname === 't.bilibili.com') {
            const legacyDynamicMatch = pathname.match(/^\/(\d+)/);
            if (legacyDynamicMatch) return { type: stateType || '17', oid: legacyDynamicMatch[1] };
        }

        const queryType = normalizeCommentType(firstString(
            params.get('comment_type'),
            params.get('type'),
            stateType
        ));
        const queryOid = firstString(
            params.get('comment_id'),
            params.get('comment_oid'),
            params.get('oid'),
            params.get('dynamic_id'),
            params.get('cvid'),
            stateOid
        );
        return { type: queryType, oid: queryOid };
    }

    function extractBvidFromUrl() {
        const match = location.pathname.match(/\/video\/(BV[a-zA-Z0-9]{10})/i);
        return match ? match[1].replace(/^bv/i, 'BV') : '';
    }

    function normalizeReplyData(raw, fallbackOid = '', fallbackType = '') {
        if (!isObject(raw)) return null;

        const rpid = readId(raw, 'rpid');
        if (!rpid) return null;

        const root = firstString(readId(raw, 'root'), '0');
        const parent = firstString(readId(raw, 'parent'), '0');
        const dialog = firstString(readId(raw, 'dialog'), '0');
        const oid = firstString(
            readId(raw, 'oid'),
            readId(raw, 'comment_id'),
            raw.comment_oid,
            fallbackOid
        );
        const type = firstString(
            readId(raw, 'type'),
            readId(raw, 'comment_type'),
            raw.commentType,
            fallbackType
        );
        const member = isObject(raw.member) ? raw.member : {};
        const content = isObject(raw.content) ? raw.content : {};
        const control = isObject(raw.reply_control) ? raw.reply_control : {};
        const actionValue = Number(raw.action);
        const action = actionValue === 1 || actionValue === 2 ? actionValue : 0;

        return {
            rpid,
            root,
            parent,
            dialog,
            oid,
            type,
            mid: firstString(readId(raw, 'mid'), readId(member, 'mid')),
            ctime: Number(raw.ctime) || 0,
            like: Number(raw.like) || 0,
            action,
            member,
            content,
            location: firstString(control.location, raw.location)
        };
    }

    function extractReplyData(host) {
        const pageContext = getPageContext();
        const fallbackOid = firstString(pageContext.oid, extractAidFromPageState());
        for (const raw of getRawDataCandidates(host)) {
            const normalized = normalizeReplyData(raw, fallbackOid, pageContext.type);
            if (normalized) return normalized;
        }
        return null;
    }

    function isReplyHost(element) {
        const name = safeString(element?.localName).toLowerCase();
        if (!name || name.includes('thread-renderer') || name.includes('replies-renderer')) {
            return false;
        }
        return SELECTORS.replyHost.includes(name) || (
            name.includes('comment') && name.includes('reply') && name.includes('renderer')
        );
    }

    function normalizedText(element) {
        return safeString(element?.textContent).replace(/\s+/g, ' ');
    }

    function isReplyActionElement(element) {
        if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
        const text = normalizedText(element);
        if (text !== '回复') return false;

        const tagName = safeString(element.localName).toLowerCase();
        const role = safeString(element.getAttribute?.('role')).toLowerCase();
        const className = safeString(element.getAttribute?.('class')).toLowerCase();
        const isInteractiveTag = tagName === 'button' || tagName === 'a';
        const isInteractiveRole = role === 'button';
        const looksLikeAction = /reply|action|opera|footer|interaction|info/.test(className);
        return isInteractiveTag || isInteractiveRole || looksLikeAction;
    }

    function findReplyAction(root) {
        if (!root?.querySelectorAll) return null;

        for (const element of root.querySelectorAll('*')) {
            if (isReplyActionElement(element)) {
                return { element, root };
            }
            if (element.shadowRoot) {
                observeRoot(element.shadowRoot);
                const nested = findReplyAction(element.shadowRoot);
                if (nested) return nested;
            }
        }
        return null;
    }

    function findExistingLink(root, key) {
        if (!root?.querySelectorAll) return null;

        for (const element of root.querySelectorAll(`.${LINK_CLASS}`)) {
            if (element.getAttribute('data-bdv-key') === key) return element;
        }

        for (const element of root.querySelectorAll('*')) {
            if (element.shadowRoot) {
                const nested = findExistingLink(element.shadowRoot, key);
                if (nested) return nested;
            }
        }
        return null;
    }

    function ensureShadowStyles(root) {
        if (!root) return;

        // B 站可能在复用同一个 ShadowRoot 时重建子节点。不能只依赖
        // WeakSet 标记，否则样式节点被清掉后不会再注入。
        const existingStyle = root.querySelector?.('style[data-bdv-style="true"]');
        if (existingStyle) {
            state.styledRoots.add(root);
            return;
        }
        state.styledRoots.delete(root);

        const style = document.createElement('style');
        style.setAttribute('data-bdv-style', 'true');
        style.textContent = `
            .${LINK_CLASS} {
                appearance: none;
                -webkit-appearance: none;
                border: 0;
                margin: 0 0 0 14px;
                padding: 0;
                background: transparent;
                color: inherit;
                font: inherit;
                line-height: inherit;
                cursor: pointer;
                white-space: nowrap;
                text-decoration: none;
                vertical-align: baseline;
                transition: color .15s ease, opacity .15s ease;
            }
            .${LINK_CLASS}:hover,
            .${LINK_CLASS}:focus-visible {
                color: #00aeec;
                outline: none;
            }
            .${LINK_CLASS}[aria-busy="true"] {
                opacity: .65;
                cursor: wait;
            }
        `;
        try {
            root.appendChild(style);
            state.styledRoots.add(root);
        } catch (_) {
            state.styledRoots.delete(root);
        }
    }

    function createDialogLink(host, info, targetRoot) {
        const link = document.createElement('button');
        link.type = 'button';
        link.className = LINK_CLASS;
        link.textContent = '查看对话';
        link.setAttribute('data-bdv-key', `${info.oid}:${info.root}:${info.dialog}:${info.rpid}`);
        link.setAttribute('aria-label', '查看这条回复所属的对话');

        const open = (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (link.getAttribute('aria-busy') === 'true') return;
            openDialogPanel(info, link);
        };

        link.addEventListener('click', open);
        link.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') open(event);
        });

        ensureShadowStyles(targetRoot);
        return link;
    }

    function insertDialogLink(host, info) {
        if (!info || !info.rpid || !info.root || info.root === '0' || !info.type) return;
        if (!info.dialog || info.dialog === '0' || info.dialog === info.rpid) return;

        const shadowRoot = host.shadowRoot;
        if (!shadowRoot) return;

        const key = `${info.oid}:${info.root}:${info.dialog}:${info.rpid}`;
        if (findExistingLink(shadowRoot, key)) return;

        const action = findReplyAction(shadowRoot);
        if (!action?.element) return;

        const link = createDialogLink(host, info, action.root);
        const target = action.element;
        if (target.parentElement) {
            target.insertAdjacentElement('afterend', link);
        } else {
            action.root.appendChild(link);
        }
    }

    function processReplyHost(host) {
        if (!isReplyHost(host) || !host.shadowRoot) return;
        const info = extractReplyData(host);
        if (!info) return;
        rememberPageMentionData(info);
        insertDialogLink(host, info);
    }

    function isScanNode(node) {
        return node && (
            node.nodeType === Node.ELEMENT_NODE
            || node.nodeType === Node.DOCUMENT_FRAGMENT_NODE
            || node.nodeType === Node.DOCUMENT_NODE
        );
    }

    function queueScanNode(node) {
        if (isScanNode(node)) state.pendingScanNodes.add(node);
    }

    function scheduleScan(nodes = []) {
        for (const node of nodes) queueScanNode(node);
        if (state.scanTimer) return;
        state.scanTimer = window.setTimeout(() => {
            state.scanTimer = null;
            scan();
        }, CONFIG.scanDebounceMs);
    }

    function scheduleFullScan() {
        state.fullScanPending = true;
        scheduleScan();
    }

    function handleMutationRecords(records) {
        const nodes = [];
        let hasUsefulNode = false;

        for (const record of records || []) {
            if (record.type !== 'childList') continue;

            if (record.target?.nodeType !== Node.DOCUMENT_NODE) {
                nodes.push(record.target);
            }
            for (const node of record.addedNodes || []) {
                if (isScanNode(node)) {
                    nodes.push(node);
                    hasUsefulNode = true;
                }
            }
        }

        if (nodes.length || hasUsefulNode) {
            scheduleScan(nodes);
        } else if ((records || []).length) {
            // 兜底处理没有可定位 addedNode 的页面重建。
            scheduleFullScan();
        }
    }

    function observeRoot(root) {
        if (!root || state.observedRoots.has(root)) return;
        state.observedRoots.add(root);

        const observer = new MutationObserver(handleMutationRecords);
        try {
            observer.observe(root, { childList: true, subtree: true });
        } catch (_) {
            state.observedRoots.delete(root);
        }
    }

    function visitNode(node) {
        if (!isScanNode(node)) return;

        if (node.nodeType === Node.ELEMENT_NODE) {
            if (isReplyHost(node)) processReplyHost(node);
            if (node.shadowRoot) visitRoot(node.shadowRoot);
        }

        if (!node.querySelectorAll) return;
        for (const element of node.querySelectorAll('*')) {
            if (isReplyHost(element)) processReplyHost(element);
            if (element.shadowRoot) visitRoot(element.shadowRoot);
        }
    }

    function visitRoot(root) {
        if (!root?.querySelectorAll) return;
        observeRoot(root);
        visitNode(root);
    }

    function scan() {
        if (state.scanning) return;
        state.scanning = true;
        try {
            if (state.fullScanPending) {
                state.fullScanPending = false;
                state.pendingScanNodes.clear();
                visitRoot(document);
                return;
            }

            const nodes = [...state.pendingScanNodes];
            state.pendingScanNodes.clear();
            for (const node of nodes) visitNode(node);
        } finally {
            state.scanning = false;
        }
    }

    function ensureGlobalStyles() {
        if (document.getElementById(GLOBAL_STYLE_ID)) return;

        const mount = document.head || document.documentElement;
        if (!mount) {
            window.addEventListener('DOMContentLoaded', ensureGlobalStyles, { once: true });
            return;
        }

        const style = document.createElement('style');
        style.id = GLOBAL_STYLE_ID;
        style.textContent = `
            .bdv-dialog-overlay {
                position: fixed;
                inset: 0;
                z-index: 2147483000;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 20px;
                background: rgba(0, 0, 0, .42);
                animation: bdv-fade-in .12s ease-out;
            }
            .bdv-dialog-panel {
                width: min(660px, calc(100vw - 28px));
                max-height: min(78vh, 720px);
                display: flex;
                flex-direction: column;
                overflow: hidden;
                color: #18191c;
                background: #fff;
                border: 1px solid rgba(0, 0, 0, .08);
                border-radius: 10px;
                box-shadow: 0 14px 44px rgba(0, 0, 0, .22);
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
            }
            .bdv-dialog-header {
                min-height: 48px;
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 0 16px 0 20px;
                border-bottom: 1px solid #f1f2f3;
                font-size: 16px;
                font-weight: 600;
            }
            .bdv-dialog-close {
                width: 30px;
                height: 30px;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                border: 0;
                border-radius: 6px;
                background: transparent;
                color: #9499a0;
                font-size: 24px;
                line-height: 1;
                cursor: pointer;
            }
            .bdv-dialog-close:hover,
            .bdv-dialog-close:focus-visible {
                color: #18191c;
                background: #f1f2f3;
                outline: none;
            }
            .bdv-dialog-body {
                flex: 1;
                min-height: 96px;
                overflow: auto;
                padding: 8px 20px 18px;
                overscroll-behavior: contain;
            }
            .bdv-dialog-status {
                padding: 28px 8px;
                color: #9499a0;
                text-align: center;
                font-size: 14px;
            }
            .bdv-dialog-item {
                display: grid;
                grid-template-columns: 40px minmax(0, 1fr);
                gap: 10px;
                padding: 14px 0;
                border-bottom: 1px solid #f1f2f3;
            }
            .bdv-dialog-item:last-child { border-bottom: 0; }
            .bdv-dialog-item[data-current="true"] {
                margin: 0 -10px;
                padding-left: 10px;
                padding-right: 10px;
                border-radius: 7px;
                background: rgba(0, 174, 236, .07);
            }
            .bdv-dialog-avatar-link {
                display: block;
                width: 40px;
                height: 40px;
                border-radius: 50%;
                outline: none;
            }
            .bdv-dialog-avatar-link:focus-visible {
                box-shadow: 0 0 0 2px #00aeec;
            }
            .bdv-dialog-avatar {
                display: block;
                width: 40px;
                height: 40px;
                border-radius: 50%;
                object-fit: cover;
                background: #f1f2f3;
                transition: box-shadow .15s ease;
            }
            .bdv-dialog-avatar-link:hover .bdv-dialog-avatar {
                box-shadow: 0 0 0 2px rgba(0, 174, 236, .35);
            }
            .bdv-dialog-main { min-width: 0; }
            .bdv-dialog-user {
                display: flex;
                flex-wrap: wrap;
                align-items: center;
                gap: 6px;
                font-size: 13px;
                line-height: 20px;
            }
            .bdv-dialog-username-link,
            .bdv-dialog-username-text {
                max-width: min(260px, 100%);
                overflow: hidden;
                color: #61666d;
                font-weight: 500;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .bdv-dialog-username-link {
                text-decoration: none;
                transition: color .15s ease;
            }
            .bdv-dialog-username-link:hover,
            .bdv-dialog-username-link:focus-visible {
                color: #00aeec;
                outline: none;
            }
            .bdv-dialog-level {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                min-width: 22px;
                height: 14px;
                padding: 0 3px;
                border-radius: 3px;
                color: #fff;
                font-size: 9px;
                line-height: 14px;
                font-weight: 700;
                letter-spacing: -.2px;
            }
            .bdv-dialog-level--0 { background: #9499a0; }
            .bdv-dialog-level--1 { background: #8a8f99; }
            .bdv-dialog-level--2 { background: #6f8bb5; }
            .bdv-dialog-level--3 { background: #5d9fc9; }
            .bdv-dialog-level--4 { background: #8c83c7; }
            .bdv-dialog-level--5 { background: #e58aa8; }
            .bdv-dialog-level--6 { background: #f0a35e; }
            .bdv-dialog-vip {
                color: #f0a35e;
                font-size: 11px;
                font-weight: 600;
            }
            .bdv-dialog-message {
                margin-top: 2px;
                color: #18191c;
                font-size: 14px;
                line-height: 1.65;
                white-space: pre-wrap;
                word-break: break-word;
            }
            .bdv-dialog-emote {
                width: 22px;
                height: 22px;
                margin: 0 2px;
                vertical-align: -6px;
                object-fit: contain;
            }
            .bdv-dialog-meta {
                display: flex;
                flex-wrap: wrap;
                align-items: center;
                gap: 14px;
                margin-top: 6px;
                color: #9499a0;
                font-size: 12px;
                line-height: 18px;
            }
            .bdv-dialog-action {
                display: inline-flex;
                align-items: center;
                gap: 4px;
                min-height: 22px;
                margin: 0;
                padding: 0;
                border: 0;
                background: transparent;
                color: #9499a0;
                font: inherit;
                cursor: pointer;
                transition: color .15s ease, opacity .15s ease;
            }
            .bdv-dialog-action[data-action="dislike"] {
                gap: 0;
            }
            .bdv-dialog-action:hover,
            .bdv-dialog-action:focus-visible {
                color: #00aeec;
                outline: none;
            }
            .bdv-dialog-action[data-active="true"] {
                color: #00aeec;
            }
            .bdv-dialog-action[data-action="dislike"][data-active="true"] {
                color: #61666d;
            }
            .bdv-dialog-action[aria-busy="true"] {
                opacity: .55;
                cursor: wait;
            }
            .bdv-dialog-action-icon {
                display: inline-flex;
                width: 15px;
                height: 15px;
                flex: 0 0 15px;
            }
            .bdv-dialog-action-icon svg {
                width: 100%;
                height: 100%;
            }
            .bdv-dialog-composer {
                position: relative;
                display: flex;
                flex-direction: column;
                gap: 8px;
                padding: 12px 20px 14px;
                border-top: 1px solid #f1f2f3;
                background: rgba(255, 255, 255, .98);
                z-index: 2;
            }
            .bdv-dialog-composer[hidden] { display: none; }
            .bdv-dialog-composer-title {
                color: #61666d;
                font-size: 12px;
            }
            .bdv-dialog-composer textarea {
                width: 100%;
                min-height: 54px;
                box-sizing: border-box;
                resize: vertical;
                padding: 8px 10px;
                border: 1px solid #e3e5e7;
                border-radius: 6px;
                color: #18191c;
                background: #fff;
                font: inherit;
                font-size: 13px;
                line-height: 1.5;
                outline: none;
            }
            .bdv-dialog-composer textarea:focus {
                border-color: #00aeec;
                box-shadow: 0 0 0 2px rgba(0, 174, 236, .12);
            }
            .bdv-dialog-composer-footer {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 10px;
            }
            .bdv-dialog-composer-toolbar {
                display: flex;
                align-items: center;
                gap: 10px;
                min-width: 0;
            }
            .bdv-dialog-composer-tools {
                display: flex;
                align-items: center;
                gap: 6px;
            }
            .bdv-dialog-tool-button {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 28px;
                height: 26px;
                padding: 0;
                border: 1px solid #e3e5e7;
                border-radius: 5px;
                color: #61666d;
                background: #fff;
                font: inherit;
                font-size: 16px;
                line-height: 1;
                cursor: pointer;
                transition: color .15s ease, border-color .15s ease, background .15s ease;
            }
            .bdv-dialog-tool-button:hover,
            .bdv-dialog-tool-button:focus-visible,
            .bdv-dialog-tool-button[aria-expanded="true"] {
                border-color: #00aeec;
                color: #00aeec;
                background: rgba(0, 174, 236, .06);
                outline: none;
            }
            .bdv-dialog-tool-button:disabled {
                opacity: .55;
                cursor: wait;
            }
            .bdv-dialog-emote-panel,
            .bdv-dialog-mention-panel {
                position: absolute;
                bottom: 62px;
                box-sizing: border-box;
                overflow: hidden;
                border: 1px solid #e3e5e7;
                border-radius: 8px;
                color: #18191c;
                background: #fff;
                box-shadow: 0 8px 28px rgba(0, 0, 0, .16);
                z-index: 5;
            }
            .bdv-dialog-emote-panel[hidden],
            .bdv-dialog-mention-panel[hidden] {
                display: none;
            }
            .bdv-dialog-emote-panel {
                left: 20px;
                right: 20px;
                width: auto;
                max-width: calc(100% - 40px);
                max-height: min(300px, calc(100vh - 120px));
                display: flex;
                flex-direction: column;
            }
            .bdv-dialog-mention-panel {
                left: 54px;
                width: min(330px, calc(100% - 40px));
                max-height: 320px;
                overflow: auto;
            }
            .bdv-dialog-emote-tabs {
                box-sizing: border-box;
                display: flex;
                flex: 0 0 auto;
                min-width: 0;
                max-width: 100%;
                gap: 2px;
                overflow-x: auto;
                padding: 7px 8px 0;
                border-bottom: 1px solid #f1f2f3;
                scrollbar-width: thin;
            }
            .bdv-dialog-emote-tab {
                flex: 0 0 auto;
                max-width: 130px;
                padding: 5px 8px 7px;
                border: 0;
                border-bottom: 2px solid transparent;
                color: #9499a0;
                background: transparent;
                font: inherit;
                font-size: 12px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                cursor: pointer;
            }
            .bdv-dialog-emote-tab:hover,
            .bdv-dialog-emote-tab:focus-visible,
            .bdv-dialog-emote-tab[data-active="true"] {
                border-bottom-color: #00aeec;
                color: #00aeec;
                outline: none;
            }
            .bdv-dialog-emote-grid {
                box-sizing: border-box;
                display: grid;
                flex: 1 1 auto;
                min-width: 0;
                min-height: 0;
                width: 100%;
                grid-template-columns: repeat(auto-fill, minmax(40px, 1fr));
                gap: 4px;
                max-height: min(205px, calc(100vh - 190px));
                overflow-y: auto;
                padding: 10px;
            }
            .bdv-dialog-emote-button {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                min-width: 0;
                min-height: 42px;
                padding: 4px;
                border: 1px solid transparent;
                border-radius: 6px;
                background: transparent;
                cursor: pointer;
            }
            .bdv-dialog-emote-button:hover,
            .bdv-dialog-emote-button:focus-visible {
                border-color: #b3e8f7;
                background: #f1fbfe;
                outline: none;
            }
            .bdv-dialog-emote-button img {
                display: block;
                width: 32px;
                height: 32px;
                object-fit: contain;
            }
            .bdv-dialog-emote-empty,
            .bdv-dialog-mention-empty {
                padding: 18px 12px;
                color: #9499a0;
                text-align: center;
                font-size: 12px;
            }
            .bdv-dialog-mention-title {
                position: sticky;
                top: 0;
                padding: 10px 12px 8px;
                border-bottom: 1px solid #f1f2f3;
                color: #61666d;
                background: #fff;
                font-size: 12px;
                z-index: 1;
            }
            .bdv-dialog-mention-list {
                display: flex;
                flex-direction: column;
                padding: 4px 6px 8px;
            }
            .bdv-dialog-mention-group + .bdv-dialog-mention-group {
                margin-top: 4px;
                border-top: 1px solid #f1f2f3;
                padding-top: 4px;
            }
            .bdv-dialog-mention-group-title {
                padding: 5px 8px 4px;
                color: #9499a0;
                font-size: 12px;
            }
            .bdv-dialog-mention-item {
                display: flex;
                align-items: flex-start;
                gap: 8px;
                width: 100%;
                padding: 7px 8px;
                border: 0;
                border-radius: 5px;
                color: #18191c;
                background: transparent;
                font: inherit;
                text-align: left;
                cursor: pointer;
            }
            .bdv-dialog-mention-item:hover,
            .bdv-dialog-mention-item:focus-visible {
                background: #f1f2f3;
                outline: none;
            }
            .bdv-dialog-mention-avatar {
                width: 32px;
                height: 32px;
                flex: 0 0 32px;
                border-radius: 50%;
                object-fit: cover;
                background: #f1f2f3;
            }
            .bdv-dialog-mention-content {
                display: flex;
                flex-direction: column;
                min-width: 0;
                gap: 2px;
                padding-top: 1px;
            }
            .bdv-dialog-mention-text {
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                font-size: 12px;
            }
            .bdv-dialog-mention-fans {
                color: #9499a0;
                font-size: 11px;
                line-height: 16px;
            }
            .bdv-dialog-mention-level {
                margin-left: 4px;
                vertical-align: 1px;
            }
            .bdv-dialog-composer-count {
                color: #9499a0;
                font-size: 12px;
            }
            .bdv-dialog-composer-buttons {
                display: flex;
                gap: 8px;
            }
            .bdv-dialog-composer-button {
                min-width: 56px;
                padding: 5px 12px;
                border: 1px solid #e3e5e7;
                border-radius: 6px;
                color: #61666d;
                background: #fff;
                font: inherit;
                font-size: 12px;
                cursor: pointer;
            }
            .bdv-dialog-composer-button--submit {
                border-color: #00aeec;
                color: #fff;
                background: #00aeec;
            }
            .bdv-dialog-composer-button:disabled {
                opacity: .55;
                cursor: wait;
            }
            .bdv-dialog-current {
                color: #00aeec;
            }
            .bdv-dialog-notice {
                padding: 6px 0 4px;
                font-size: 12px;
                line-height: 18px;
            }
            .bdv-dialog-error {
                color: #9499a0;
            }
            @keyframes bdv-fade-in {
                from { opacity: 0; }
                to { opacity: 1; }
            }
            @media (max-width: 640px) {
                .bdv-dialog-overlay {
                    align-items: flex-end;
                    padding: 0;
                }
                .bdv-dialog-panel {
                    width: 100%;
                    max-height: 78vh;
                    border-radius: 12px 12px 0 0;
                }
                .bdv-dialog-emote-panel {
                    left: 12px;
                    right: 12px;
                    max-width: calc(100% - 24px);
                    max-height: min(300px, calc(100vh - 108px));
                }
                .bdv-dialog-emote-grid {
                    max-height: min(205px, calc(100vh - 178px));
                }
            }
            :is(html.dark, body.dark, html[data-theme="dark"]) .bdv-dialog-panel {
                color: #e5e7eb;
                background: #18191c;
                border-color: rgba(255, 255, 255, .08);
            }
            :is(html.dark, body.dark, html[data-theme="dark"]) .bdv-dialog-header,
            :is(html.dark, body.dark, html[data-theme="dark"]) .bdv-dialog-item {
                border-color: #303236;
            }
            :is(html.dark, body.dark, html[data-theme="dark"]) .bdv-dialog-close:hover,
            :is(html.dark, body.dark, html[data-theme="dark"]) .bdv-dialog-close:focus-visible {
                color: #e5e7eb;
                background: #303236;
            }
            :is(html.dark, body.dark, html[data-theme="dark"]) .bdv-dialog-message {
                color: #e5e7eb;
            }
            :is(html.dark, body.dark, html[data-theme="dark"]) .bdv-dialog-composer {
                border-color: #303236;
                background: rgba(24, 25, 28, .98);
            }
            :is(html.dark, body.dark, html[data-theme="dark"]) .bdv-dialog-composer textarea,
            :is(html.dark, body.dark, html[data-theme="dark"]) .bdv-dialog-composer-button {
                border-color: #44474d;
                color: #e5e7eb;
                background: #18191c;
            }
            :is(html.dark, body.dark, html[data-theme="dark"]) .bdv-dialog-tool-button,
            :is(html.dark, body.dark, html[data-theme="dark"]) .bdv-dialog-emote-panel,
            :is(html.dark, body.dark, html[data-theme="dark"]) .bdv-dialog-mention-panel {
                border-color: #44474d;
                color: #e5e7eb;
                background: #18191c;
            }
            :is(html.dark, body.dark, html[data-theme="dark"]) .bdv-dialog-emote-tabs,
            :is(html.dark, body.dark, html[data-theme="dark"]) .bdv-dialog-mention-title,
            :is(html.dark, body.dark, html[data-theme="dark"]) .bdv-dialog-mention-group + .bdv-dialog-mention-group {
                border-color: #303236;
            }
            :is(html.dark, body.dark, html[data-theme="dark"]) .bdv-dialog-emote-tab,
            :is(html.dark, body.dark, html[data-theme="dark"]) .bdv-dialog-tool-button {
                color: #b6bdc8;
                background: #18191c;
            }
            :is(html.dark, body.dark, html[data-theme="dark"]) .bdv-dialog-emote-tab:hover,
            :is(html.dark, body.dark, html[data-theme="dark"]) .bdv-dialog-emote-tab:focus-visible,
            :is(html.dark, body.dark, html[data-theme="dark"]) .bdv-dialog-emote-tab[data-active="true"],
            :is(html.dark, body.dark, html[data-theme="dark"]) .bdv-dialog-tool-button:hover,
            :is(html.dark, body.dark, html[data-theme="dark"]) .bdv-dialog-tool-button:focus-visible,
            :is(html.dark, body.dark, html[data-theme="dark"]) .bdv-dialog-tool-button[aria-expanded="true"] {
                border-bottom-color: #00aeec;
                border-color: #00aeec;
                color: #00aeec;
                background: rgba(0, 174, 236, .1);
            }
            :is(html.dark, body.dark, html[data-theme="dark"]) .bdv-dialog-emote-button:hover,
            :is(html.dark, body.dark, html[data-theme="dark"]) .bdv-dialog-emote-button:focus-visible,
            :is(html.dark, body.dark, html[data-theme="dark"]) .bdv-dialog-mention-item:hover,
            :is(html.dark, body.dark, html[data-theme="dark"]) .bdv-dialog-mention-item:focus-visible {
                border-color: #36535e;
                background: #303236;
            }
            :is(html.dark, body.dark, html[data-theme="dark"]) .bdv-dialog-mention-group-title,
            :is(html.dark, body.dark, html[data-theme="dark"]) .bdv-dialog-mention-fans {
                color: #9499a0;
            }
            :is(html.dark, body.dark, html[data-theme="dark"]) .bdv-dialog-mention-title {
                background: #18191c;
            }
            :is(html.dark, body.dark, html[data-theme="dark"]) .bdv-dialog-composer-button--submit {
                border-color: #00aeec;
                color: #fff;
                background: #00aeec;
            }
        `;
        mount.appendChild(style);
    }

    function toSafeUrl(value) {
        const url = safeString(value);
        if (!url) return '';
        if (url.startsWith('//')) return `https:${url}`;
        if (/^http:\/\//i.test(url)) return `https://${url.slice(7)}`;
        return /^https?:\/\//i.test(url) ? url : '';
    }

    function formatTime(timestamp) {
        const seconds = Number(timestamp);
        if (!Number.isFinite(seconds) || seconds <= 0) return '未知时间';

        const diff = Math.max(0, Date.now() - seconds * 1000);
        const minute = 60 * 1000;
        const hour = 60 * minute;
        const day = 24 * hour;
        if (diff < minute) return '刚刚';
        if (diff < hour) return `${Math.floor(diff / minute)}分钟前`;
        if (diff < day) return `${Math.floor(diff / hour)}小时前`;
        if (diff < 30 * day) return `${Math.floor(diff / day)}天前`;

        const date = new Date(seconds * 1000);
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const dayValue = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${dayValue}`;
    }

    function validColor(value) {
        const color = safeString(value);
        return /^#[0-9a-f]{3,8}$/i.test(color) ? color : '';
    }

    function createTextElement(tagName, className, text) {
        const element = document.createElement(tagName);
        element.className = className;
        element.textContent = text;
        return element;
    }

    function formatCount(value) {
        const count = Math.max(0, Number(value) || 0);
        if (count >= 10000) {
            const digits = count >= 100000 ? 0 : 1;
            return `${(count / 10000).toFixed(digits)}万`;
        }
        return String(count);
    }

    function profileHref(mid) {
        const userId = safeString(mid);
        return /^\d+$/.test(userId) ? `https://space.bilibili.com/${userId}` : '';
    }

    function createSvgIcon(kind) {
        const svgNamespace = 'http://www.w3.org/2000/svg';
        const wrapper = document.createElement('span');
        wrapper.className = 'bdv-dialog-action-icon';
        wrapper.setAttribute('aria-hidden', 'true');

        const svg = document.createElementNS(svgNamespace, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '1.8');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');

        const path = document.createElementNS(svgNamespace, 'path');
        if (kind === 'reply') {
            path.setAttribute('d', 'M4 5h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-5 3v-3H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z');
        } else {
            path.setAttribute('d', 'M7 10v11H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3m0 11h9.3a2 2 0 0 0 1.96-1.6l1.55-7A2 2 0 0 0 17.85 9H14l.5-3.1A3.35 3.35 0 0 0 11.2 2.1L7 10');
            if (kind === 'dislike') path.setAttribute('transform', 'rotate(180 12 12)');
        }
        svg.appendChild(path);
        wrapper.appendChild(svg);
        return wrapper;
    }

    function createLevelBadge(reply) {
        const rawLevel = Number(reply.member?.level_info?.current_level);
        if (!Number.isFinite(rawLevel) || rawLevel < 0) return null;

        const level = Math.min(6, Math.max(0, Math.floor(rawLevel)));
        const badge = createTextElement('span', `bdv-dialog-level bdv-dialog-level--${level}`, `LV${level}`);
        badge.title = `用户等级 LV${level}`;
        return badge;
    }

    function renderMessageContent(container, reply) {
        const message = safeString(reply.content?.message);
        if (!message) {
            container.textContent = '[该评论没有文字内容]';
            return;
        }

        const emotes = isObject(reply.content?.emote)
            ? reply.content.emote
            : isObject(reply.content?.emotes)
                ? reply.content.emotes
                : {};
        const tokens = message.split(/(\[[^\]]+\])/g);
        for (const token of tokens) {
            const emote = emotes[token];
            const emoteUrl = isObject(emote) ? toSafeUrl(emote.url) : '';
            if (!emoteUrl) {
                container.appendChild(document.createTextNode(token));
                continue;
            }
            const image = document.createElement('img');
            image.className = 'bdv-dialog-emote';
            image.src = emoteUrl;
            image.alt = token;
            image.title = token;
            image.loading = 'lazy';
            container.appendChild(image);
        }
    }

    function createActionButton(kind, panel, reply) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'bdv-dialog-action';
        button.dataset.action = kind;
        button.setAttribute('aria-busy', 'false');

        const label = kind === 'like' ? '点赞' : kind === 'dislike' ? '点踩' : '回复';
        button.title = label;
        button.setAttribute('aria-label', label);
        button.appendChild(createSvgIcon(kind));

        const value = kind === 'dislike'
            ? null
            : createTextElement('span', 'bdv-dialog-action-value', kind === 'like' ? formatCount(reply.like) : label);
        if (value) button.appendChild(value);

        const control = { kind, button, value };
        if (kind === 'like' || kind === 'dislike') {
            button.addEventListener('click', () => toggleReplyAction(panel, reply, kind, control));
        } else {
            button.addEventListener('click', () => showReplyComposer(panel, reply));
        }
        updateActionControl(control, reply);
        return control;
    }

    function updateActionControl(control, reply) {
        if (!control || !reply) return;
        const active = control.kind === 'like'
            ? reply.action === 1
            : control.kind === 'dislike' && reply.action === 2;
        control.button.dataset.active = String(Boolean(active));
        if (control.kind === 'like') control.value.textContent = formatCount(reply.like);
    }

    function updateComposerCount(composer) {
        if (!composer?.count || !composer.textarea) return;
        composer.count.textContent = `${Array.from(composer.textarea.value).length}/1000`;
    }

    function insertComposerText(textarea, text, replaceStart = null, replaceEnd = null) {
        if (!textarea) return;

        const value = textarea.value || '';
        const currentStart = Number.isFinite(textarea.selectionStart) ? textarea.selectionStart : value.length;
        const currentEnd = Number.isFinite(textarea.selectionEnd) ? textarea.selectionEnd : currentStart;
        const rawStart = Number.isInteger(replaceStart) ? replaceStart : currentStart;
        const rawEnd = Number.isInteger(replaceEnd) ? replaceEnd : currentEnd;
        const start = Math.max(0, Math.min(value.length, rawStart));
        const end = Math.max(start, Math.min(value.length, rawEnd));
        const maxLength = Number(textarea.maxLength);
        const remaining = maxLength > -1 ? maxLength - (value.length - (end - start)) : Infinity;
        const insertion = remaining > 0
            ? Array.from(String(text ?? '')).slice(0, remaining).join('')
            : '';

        textarea.value = `${value.slice(0, start)}${insertion}${value.slice(end)}`;
        const caret = start + insertion.length;
        textarea.focus();
        try {
            textarea.setSelectionRange(caret, caret);
        } catch (_) {
            // Some embedded textareas do not expose selection APIs.
        }
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function composerMentionQuery(textarea) {
        if (!textarea) return null;
        const value = textarea.value || '';
        const caret = Number.isFinite(textarea.selectionStart) ? textarea.selectionStart : value.length;
        const beforeCaret = value.slice(0, caret);
        const match = beforeCaret.match(/@([^\s@]*)$/u);
        if (!match) return null;
        return {
            query: match[1],
            start: caret - match[1].length - 1,
            end: caret
        };
    }

    function createMentionCandidate(raw) {
        if (!isObject(raw)) return null;

        const sourceMember = isObject(raw.member) ? raw.member : raw;
        const uname = firstString(raw.uname, raw.name, sourceMember.uname, sourceMember.name)
            .replace(/<[^>]+>/g, '');
        const mid = firstString(readId(raw, 'mid'), readId(sourceMember, 'mid'));
        if (!uname) return null;

        const avatar = firstString(
            raw.avatar,
            raw.face,
            raw.upic,
            sourceMember.avatar,
            sourceMember.face
        );
        const member = { ...sourceMember };
        if (mid && !member.mid) member.mid = mid;
        if (uname && !member.uname) member.uname = uname;
        if (avatar && !member.avatar) member.avatar = avatar;
        if (!member.level_info && raw.level !== undefined) {
            member.level_info = { current_level: raw.level };
        }

        const fans = Number(firstString(raw.fans, raw.fans_num, raw.follower, sourceMember.fans)) || 0;
        return { mid, uname, avatar, fans, member };
    }

    function rememberPageMentionData(reply) {
        if (!reply || !state.pageMentionCandidates) return;
        const rawCandidates = [reply.member];
        const members = reply.content?.members;
        if (Array.isArray(members)) rawCandidates.push(...members);
        const candidates = rawCandidates.map(createMentionCandidate).filter(Boolean);
        mergeMentionCandidates(state.pageMentionCandidates, candidates);
    }

    function mentionCandidateKey(candidate) {
        return safeString(candidate?.mid) || safeString(candidate?.uname);
    }

    function mergeMentionCandidates(target, candidates) {
        for (const candidate of candidates || []) {
            if (!candidate?.uname) continue;
            const key = mentionCandidateKey(candidate);
            const previous = target.get(key);
            if (!previous) {
                target.set(key, candidate);
                continue;
            }
            target.set(key, {
                ...previous,
                ...candidate,
                avatar: previous.avatar || candidate.avatar,
                fans: Math.max(Number(previous.fans) || 0, Number(candidate.fans) || 0),
                member: { ...previous.member, ...candidate.member }
            });
        }

        if (target === state.pageMentionCandidates) {
            while (target.size > CONFIG.maxPageMentionCandidates) {
                const oldestKey = target.keys().next().value;
                if (oldestKey === undefined) break;
                target.delete(oldestKey);
            }
        }
        return [...target.values()];
    }

    function getMentionCandidates(panel) {
        const candidates = new Map();
        const addCandidate = (raw) => {
            const candidate = createMentionCandidate(raw);
            if (candidate) mergeMentionCandidates(candidates, [candidate]);
        };

        mergeMentionCandidates(candidates, state.pageMentionCandidates?.values());

        for (const reply of panel?.replies || []) {
            addCandidate(reply.member);
            const members = reply.content?.members;
            if (Array.isArray(members)) {
                for (const member of members) addCandidate(member);
            }
        }
        addCandidate(panel?.composer?.target?.member);

        return [...candidates.values()].sort((left, right) => left.uname.localeCompare(right.uname, 'zh-CN'));
    }

    function rememberMentionCandidates(panel, candidates) {
        const known = panel?.composer?.mentionCandidates;
        if (!known) return;
        mergeMentionCandidates(known, candidates);
    }

    function filterMentionCandidates(candidates, query) {
        const normalizedQuery = safeString(query).toLocaleLowerCase();
        if (!normalizedQuery) return [...(candidates || [])];
        return (candidates || []).filter((candidate) => {
            return candidate.uname.toLocaleLowerCase().includes(normalizedQuery)
                || candidate.mid === normalizedQuery;
        });
    }

    function formatMentionFans(value) {
        const fans = Number(value) || 0;
        return fans > 0 ? `${formatCount(fans)}粉丝` : '';
    }

    function getMentionGroups(panel, query = '') {
        const composer = panel?.composer;
        const normalizedQuery = safeString(query).toLocaleLowerCase();
        const recent = filterMentionCandidates(getMentionCandidates(panel), normalizedQuery).slice(0, 20);
        if (normalizedQuery) {
            const search = filterMentionCandidates(composer?.searchCandidates || [], normalizedQuery).slice(0, 20);
            return [{ title: '搜索结果', candidates: search }];
        }

        const recentKeys = new Set(recent.map(mentionCandidateKey));
        const following = (composer?.followingCandidates || [])
            .filter((candidate) => !recentKeys.has(mentionCandidateKey(candidate)))
            .slice(0, 20);
        const groups = [];
        if (recent.length) groups.push({ title: '最近联系', candidates: recent });
        if (following.length) groups.push({ title: '我的关注', candidates: following });
        return groups;
    }

    function createMentionItem(panel, candidate) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'bdv-dialog-mention-item';
        button.title = `@${candidate.uname}`;
        button.addEventListener('mousedown', (event) => event.preventDefault());

        const avatar = document.createElement('img');
        avatar.className = 'bdv-dialog-mention-avatar';
        avatar.alt = '';
        avatar.loading = 'lazy';
        const avatarUrl = toSafeUrl(candidate.avatar);
        if (avatarUrl) avatar.src = avatarUrl;

        const content = document.createElement('span');
        content.className = 'bdv-dialog-mention-content';
        const text = document.createElement('span');
        text.className = 'bdv-dialog-mention-text';
        text.textContent = candidate.uname;
        content.appendChild(text);
        const fans = formatMentionFans(candidate.fans);
        if (fans) content.appendChild(createTextElement('span', 'bdv-dialog-mention-fans', fans));
        button.append(avatar, content);

        const level = createLevelBadge({ member: candidate.member });
        if (level) {
            level.classList.add('bdv-dialog-mention-level');
            button.appendChild(level);
        }

        button.addEventListener('click', (event) => {
            event.preventDefault();
            insertMention(panel, candidate);
        });
        return button;
    }

    function renderMentionPanel(panel, query = '', groupsOverride = null) {
        const composer = panel?.composer;
        if (!composer?.mentionList || !composer.mentionTitle) return;

        const groups = Array.isArray(groupsOverride) ? groupsOverride : getMentionGroups(panel, query);
        rememberMentionCandidates(panel, groups.flatMap((group) => group.candidates || []));
        composer.mentionTitle.textContent = '选择或输入你想@的人';
        composer.mentionList.replaceChildren();

        const visibleGroups = groups.filter((group) => Array.isArray(group.candidates) && group.candidates.length);
        if (!visibleGroups.length) {
            const message = composer.searchLoading
                ? '正在搜索用户……'
                : composer.followingLoading && !safeString(query)
                    ? '正在加载关注列表……'
                    : safeString(query)
                        ? (composer.searchError || '没有找到匹配的用户')
                        : '当前对话暂无可 @ 的人';
            composer.mentionList.appendChild(createTextElement('div', 'bdv-dialog-mention-empty', message));
            return;
        }

        for (const group of visibleGroups) {
            const section = document.createElement('section');
            section.className = 'bdv-dialog-mention-group';
            section.appendChild(createTextElement('div', 'bdv-dialog-mention-group-title', group.title));
            for (const candidate of group.candidates) {
                section.appendChild(createMentionItem(panel, candidate));
            }
            composer.mentionList.appendChild(section);
        }
    }

    function updateComposerMentionMap(composer) {
        if (!composer?.mentionMap || !composer.textarea) return;
        const text = composer.textarea.value || '';
        const mentionedNames = new Set();
        for (const match of text.matchAll(/@([^\s@]+)/gu)) {
            mentionedNames.add(match[1]);
        }

        for (const [uname] of composer.mentionMap) {
            if (!mentionedNames.has(uname)) composer.mentionMap.delete(uname);
        }
        for (const candidate of composer.mentionCandidates?.values() || []) {
            if (candidate.mid && mentionedNames.has(candidate.uname)) {
                composer.mentionMap.set(candidate.uname, candidate.mid);
            }
        }
    }

    function getComposerAtNameToMid(composer) {
        updateComposerMentionMap(composer);
        const result = {};
        for (const [uname, mid] of composer?.mentionMap || []) {
            if (uname && mid) result[uname] = String(mid);
        }
        return result;
    }

    function insertMention(panel, candidate) {
        const composer = panel?.composer;
        const textarea = composer?.textarea;
        if (!textarea || !candidate?.uname) return;

        rememberMentionCandidates(panel, [candidate]);
        const mention = composerMentionQuery(textarea);
        const start = mention ? mention.start : textarea.selectionStart;
        const end = mention ? mention.end : textarea.selectionEnd;
        insertComposerText(textarea, `@${candidate.uname} `, start, end);
        if (candidate.mid) composer.mentionMap.set(candidate.uname, candidate.mid);
        updateComposerMentionMap(composer);
        hideComposerPopovers(panel);
    }

    function getPackageEmotes(packageData) {
        const value = packageData?.emote ?? packageData?.emotes;
        if (Array.isArray(value)) return value;
        return isObject(value) ? Object.values(value) : [];
    }

    // B 站网页用户搜索现在优先走 WBI；把 MD5 内置在脚本里，避免再引入
    // 一个外部 @require，从而减少和其它用户脚本的依赖/版本冲突。
    const WBI_MIXIN_KEY_ENC_TAB = Object.freeze([
        46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
        27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
        37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
        22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
    ]);

    const WBI_MD5_SHIFT = Object.freeze([
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
        5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
        4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
        6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
    ]);

    const WBI_MD5_K = Object.freeze([
        0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a,
        0xa8304613, 0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
        0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340,
        0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
        0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8,
        0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
        0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa,
        0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
        0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92,
        0xffeff47d, 0x85845dd1, 0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
        0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391
    ]);

    function md5Hex(value) {
        const text = String(value ?? '');
        let bytes;
        if (typeof TextEncoder === 'function') {
            bytes = new TextEncoder().encode(text);
        } else {
            const binary = unescape(encodeURIComponent(text));
            bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        }

        const blockLength = ((bytes.length + 9 + 63) >> 6) << 6;
        const padded = new Uint8Array(blockLength);
        padded.set(bytes);
        padded[bytes.length] = 0x80;
        const bitLength = bytes.length * 8;
        const view = new DataView(padded.buffer);
        view.setUint32(blockLength - 8, bitLength >>> 0, true);
        view.setUint32(blockLength - 4, Math.floor(bitLength / 0x100000000), true);

        let a0 = 0x67452301;
        let b0 = 0xefcdab89;
        let c0 = 0x98badcfe;
        let d0 = 0x10325476;
        const words = new Uint32Array(16);

        for (let offset = 0; offset < blockLength; offset += 64) {
            for (let index = 0; index < 16; index += 1) {
                words[index] = view.getUint32(offset + index * 4, true);
            }

            let a = a0;
            let b = b0;
            let c = c0;
            let d = d0;
            for (let index = 0; index < 64; index += 1) {
                let functionValue;
                let wordIndex;
                if (index < 16) {
                    functionValue = (b & c) | (~b & d);
                    wordIndex = index;
                } else if (index < 32) {
                    functionValue = (d & b) | (~d & c);
                    wordIndex = (5 * index + 1) % 16;
                } else if (index < 48) {
                    functionValue = b ^ c ^ d;
                    wordIndex = (3 * index + 5) % 16;
                } else {
                    functionValue = c ^ (b | ~d);
                    wordIndex = (7 * index) % 16;
                }

                const sum = (a + functionValue + WBI_MD5_K[index] + words[wordIndex]) >>> 0;
                const shift = WBI_MD5_SHIFT[index];
                const rotated = ((sum << shift) | (sum >>> (32 - shift))) >>> 0;
                const next = (b + rotated) >>> 0;
                a = d;
                d = c;
                c = b;
                b = next;
            }

            a0 = (a0 + a) >>> 0;
            b0 = (b0 + b) >>> 0;
            c0 = (c0 + c) >>> 0;
            d0 = (d0 + d) >>> 0;
        }

        const toLittleEndianHex = (word) => {
            let result = '';
            for (let index = 0; index < 4; index += 1) {
                result += `${(word >>> (index * 8) & 0xff).toString(16).padStart(2, '0')}`;
            }
            return result;
        };
        return `${toLittleEndianHex(a0)}${toLittleEndianHex(b0)}${toLittleEndianHex(c0)}${toLittleEndianHex(d0)}`;
    }

    function extractWbiKey(value) {
        const pathname = safeString(value).split('?')[0];
        const filename = pathname.slice(pathname.lastIndexOf('/') + 1);
        return filename.replace(/\.[^.]+$/, '');
    }

    async function fetchWbiKeys(signal) {
        const url = new URL(`${CONFIG.apiBase}/x/web-interface/nav`);
        const response = await fetch(url, {
            credentials: 'include',
            signal,
            headers: { Accept: 'application/json' }
        });
        if (!response.ok) throw new Error(`WBI 密钥请求失败（HTTP ${response.status}）`);
        const json = await response.json();
        if (Number(json?.code) !== 0) {
            throw new Error(json?.message || `WBI 密钥请求失败（${json?.code ?? '未知'}）`);
        }

        const imgKey = extractWbiKey(json?.data?.wbi_img?.img_url);
        const subKey = extractWbiKey(json?.data?.wbi_img?.sub_url);
        if (!imgKey || !subKey) throw new Error('当前页面没有可用的 WBI 密钥');
        return { imgKey, subKey };
    }

    function loadWbiKeys(signal) {
        if (!state.wbiPromise) {
            state.wbiPromise = fetchWbiKeys(signal).catch((error) => {
                state.wbiPromise = null;
                throw error;
            });
        }
        return state.wbiPromise;
    }

    async function signWbiParams(params, signal) {
        const { imgKey, subKey } = await loadWbiKeys(signal);
        const mixinKey = WBI_MIXIN_KEY_ENC_TAB
            .map((index) => `${imgKey}${subKey}`[index] || '')
            .join('')
            .slice(0, 32);
        const signedParams = { ...params, wts: Math.floor(Date.now() / 1000) };
        const query = Object.keys(signedParams)
            .sort()
            .map((key) => {
                const value = String(signedParams[key]).replace(/[!'()*]/g, '');
                return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
            })
            .join('&');
        return `${query}&w_rid=${md5Hex(query + mixinKey)}`;
    }

    function selectEmotePackage(panel, index) {
        const composer = panel?.composer;
        const packages = composer?.emotePackages || [];
        const packageData = packages[index];
        if (!composer || !packageData) return;

        composer.emoteTabs.querySelectorAll('.bdv-dialog-emote-tab').forEach((tab, tabIndex) => {
            tab.dataset.active = String(tabIndex === index);
        });
        composer.emoteGrid.replaceChildren();

        const emotes = getPackageEmotes(packageData);
        const usableEmotes = emotes.filter((emote) => firstString(emote?.text) && toSafeUrl(emote?.url));
        if (!usableEmotes.length) {
            composer.emoteGrid.appendChild(createTextElement('div', 'bdv-dialog-emote-empty', '这个表情包暂时没有可用表情'));
            return;
        }

        for (const emote of usableEmotes) {
            const token = firstString(emote.text);
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'bdv-dialog-emote-button';
            button.title = token;
            button.setAttribute('aria-label', token);
            button.addEventListener('mousedown', (event) => event.preventDefault());

            const image = document.createElement('img');
            image.src = toSafeUrl(emote.url);
            image.alt = token;
            image.loading = 'lazy';
            button.appendChild(image);
            button.addEventListener('click', (event) => {
                event.preventDefault();
                insertComposerText(composer.textarea, token);
                hideComposerPopovers(panel);
            });
            composer.emoteGrid.appendChild(button);
        }
    }

    function renderEmotePanel(panel, packages) {
        const composer = panel?.composer;
        if (!composer) return;

        composer.emotePackages = Array.isArray(packages) ? packages : [];
        composer.emoteTabs.replaceChildren();
        composer.emoteGrid.replaceChildren();
        if (!composer.emotePackages.length) {
            composer.emoteGrid.appendChild(createTextElement('div', 'bdv-dialog-emote-empty', '暂无可用表情'));
            return;
        }

        composer.emotePackages.forEach((packageData, index) => {
            const tab = createTextElement(
                'button',
                'bdv-dialog-emote-tab',
                firstString(packageData.text, packageData.name, `表情${index + 1}`)
            );
            tab.type = 'button';
            tab.dataset.active = String(index === 0);
            tab.addEventListener('click', (event) => {
                event.preventDefault();
                selectEmotePackage(panel, index);
            });
            composer.emoteTabs.appendChild(tab);
        });
        selectEmotePackage(panel, 0);
    }

    async function fetchEmotePackages(signal) {
        const url = new URL(`${CONFIG.apiBase}/x/emote/user/panel/web`);
        url.searchParams.set('business', 'reply');
        url.searchParams.set('web_location', '333.788');
        const response = await fetch(url, {
            credentials: 'include',
            signal,
            headers: { Accept: 'application/json' }
        });
        if (!response.ok) throw new Error(`表情列表请求失败（HTTP ${response.status}）`);
        const json = await response.json();
        if (Number(json?.code) !== 0) {
            throw new Error(json?.message || `表情列表请求失败（${json?.code ?? '未知'}）`);
        }

        const packages = Array.isArray(json?.data?.packages) ? json.data.packages : [];
        return packages.map((packageData) => {
            const emote = getPackageEmotes(packageData);
            return { ...packageData, emote };
        }).filter((packageData) => packageData.emote.length);
    }

    function loadEmotePackages(signal) {
        if (!state.emotePromise) {
            state.emotePromise = fetchEmotePackages(signal).catch((error) => {
                state.emotePromise = null;
                throw error;
            });
        }
        return state.emotePromise;
    }

    function flattenMentionSearchResults(value) {
        const result = [];
        const visit = (item) => {
            if (Array.isArray(item)) {
                item.forEach(visit);
                return;
            }
            if (!isObject(item)) return;
            if (Array.isArray(item.data)) {
                visit(item.data);
                return;
            }
            if (Array.isArray(item.result)) {
                visit(item.result);
                return;
            }
            if (item.result_type && item.result_type !== 'bili_user') return;
            if (item.uname || item.name || item.mid || item.mid_str) result.push(item);
        };
        visit(value);
        return result;
    }

    async function fetchMentionSearch(keyword, signal) {
        const query = safeString(keyword);
        if (!query) return [];

        const params = {
            search_type: 'bili_user',
            keyword: query,
            page: 1,
            page_size: 20,
            order: '0',
            order_sort: 0,
            user_type: 0,
            web_location: '333.788'
        };

        let response;
        let json;
        let wbiError = null;
        try {
            const signedQuery = await signWbiParams(params, signal);
            const wbiUrl = new URL(`${CONFIG.apiBase}/x/web-interface/wbi/search/type`);
            wbiUrl.search = `?${signedQuery}`;
            response = await fetch(wbiUrl, {
                credentials: 'include',
                signal,
                headers: { Accept: 'application/json' }
            });
            if (!response.ok) throw new Error(`用户搜索失败（HTTP ${response.status}）`);
            json = await response.json();
            if (Number(json?.code) !== 0) {
                throw new Error(json?.message || `用户搜索失败（${json?.code ?? '未知'}）`);
            }
        } catch (error) {
            if (signal?.aborted || error?.name === 'AbortError') throw error;
            wbiError = error;

            // WBI 密钥偶发取不到时保留旧接口回退；旧接口在部分页面仍会返回
            // 结果，但不再作为首选，避免新网页直接被 -403 卡死。
            const legacyUrl = new URL(`${CONFIG.apiBase}/x/web-interface/search/type`);
            Object.entries(params).forEach(([key, value]) => legacyUrl.searchParams.set(key, String(value)));
            response = await fetch(legacyUrl, {
                credentials: 'include',
                signal,
                headers: { Accept: 'application/json' }
            });
            if (!response.ok) throw wbiError || new Error(`用户搜索失败（HTTP ${response.status}）`);
            json = await response.json();
            if (Number(json?.code) !== 0) {
                throw new Error(json?.message || wbiError?.message || `用户搜索失败（${json?.code ?? '未知'}）`);
            }
        }

        const result = flattenMentionSearchResults(json?.data?.result ?? json?.data);
        return mergeMentionCandidates(
            new Map(),
            result.map(createMentionCandidate).filter(Boolean)
        );
    }

    async function fetchFollowingCandidates(signal) {
        const navUrl = new URL(`${CONFIG.apiBase}/x/web-interface/nav`);
        const navResponse = await fetch(navUrl, {
            credentials: 'include',
            signal,
            headers: { Accept: 'application/json' }
        });
        if (!navResponse.ok) throw new Error(`登录信息请求失败（HTTP ${navResponse.status}）`);
        const navJson = await navResponse.json();
        if (Number(navJson?.code) !== 0 || !navJson?.data?.isLogin) return [];

        const mid = firstString(navJson?.data?.mid);
        if (!mid) return [];
        const url = new URL(`${CONFIG.apiBase}/x/relation/followings`);
        url.searchParams.set('vmid', mid);
        url.searchParams.set('pn', '1');
        url.searchParams.set('ps', '20');
        url.searchParams.set('order', 'desc');
        url.searchParams.set('order_type', 'attention');
        const response = await fetch(url, {
            credentials: 'include',
            signal,
            headers: { Accept: 'application/json' }
        });
        if (!response.ok) throw new Error(`关注列表请求失败（HTTP ${response.status}）`);
        const json = await response.json();
        if (Number(json?.code) !== 0) {
            throw new Error(json?.message || `关注列表请求失败（${json?.code ?? '未知'}）`);
        }

        const list = Array.isArray(json?.data?.list) ? json.data.list : [];
        return list.map(createMentionCandidate).filter(Boolean);
    }

    function loadFollowingCandidates(signal) {
        if (!state.followingPromise) {
            state.followingPromise = fetchFollowingCandidates(signal).catch((error) => {
                state.followingPromise = null;
                throw error;
            });
        }
        return state.followingPromise;
    }

    async function loadFollowingForPanel(panel) {
        const composer = panel?.composer;
        if (!composer || composer.followingLoaded || composer.followingLoading) return;

        composer.followingLoading = true;
        renderMentionPanel(panel, '');
        const controller = new AbortController();
        state.interactionControllers.add(controller);
        try {
            const candidates = await loadFollowingCandidates(controller.signal);
            if (state.activePanel === panel && !controller.signal.aborted) {
                composer.followingCandidates = candidates;
                composer.followingLoaded = true;
            }
        } catch (_) {
            // The conversation participants remain available if relation data is unavailable.
        } finally {
            composer.followingLoading = false;
            state.interactionControllers.delete(controller);
            if (state.activePanel === panel && !composerMentionQuery(composer.textarea)) {
                renderMentionPanel(panel, '');
            }
        }
    }

    function cancelMentionSearch(composer) {
        if (!composer) return;
        if (composer.mentionSearchTimer) {
            window.clearTimeout(composer.mentionSearchTimer);
            composer.mentionSearchTimer = null;
        }
        composer.mentionSearchController?.abort();
        composer.mentionSearchController = null;
    }

    function scheduleMentionSearch(panel, query) {
        const composer = panel?.composer;
        if (!composer) return;

        cancelMentionSearch(composer);
        composer.mentionSearchVersion += 1;
        const version = composer.mentionSearchVersion;
        const normalizedQuery = safeString(query);
        composer.searchError = '';

        if (!normalizedQuery) {
            composer.searchLoading = false;
            composer.searchCandidates = [];
            renderMentionPanel(panel, '');
            loadFollowingForPanel(panel);
            return;
        }

        composer.searchLoading = true;
        composer.searchCandidates = [];
        renderMentionPanel(panel, normalizedQuery, [{ title: '搜索结果', candidates: [] }]);
        composer.mentionSearchTimer = window.setTimeout(async () => {
            const controller = new AbortController();
            composer.mentionSearchController = controller;
            state.interactionControllers.add(controller);
            try {
                const candidates = await fetchMentionSearch(normalizedQuery, controller.signal);
                if (state.activePanel === panel && !controller.signal.aborted && composer.mentionSearchVersion === version) {
                    composer.searchCandidates = candidates;
                    composer.searchLoading = false;
                    rememberMentionCandidates(panel, candidates);
                    renderMentionPanel(panel, normalizedQuery);
                }
            } catch (error) {
                if (state.activePanel === panel && !controller.signal.aborted && composer.mentionSearchVersion === version) {
                    const localFallback = filterMentionCandidates([
                        ...getMentionCandidates(panel),
                        ...(composer.followingCandidates || [])
                    ], normalizedQuery).slice(0, 20);
                    composer.searchCandidates = localFallback;
                    composer.searchLoading = false;
                    composer.searchError = localFallback.length ? '' : (error?.message || '用户搜索失败');
                    rememberMentionCandidates(panel, localFallback);
                    renderMentionPanel(panel, normalizedQuery);
                }
            } finally {
                state.interactionControllers.delete(controller);
                if (composer.mentionSearchController === controller) composer.mentionSearchController = null;
            }
        }, 220);
    }

    function hideComposerPopovers(panel) {
        const composer = panel?.composer;
        if (!composer) return;
        cancelMentionSearch(composer);
        composer.searchLoading = false;
        if (composer.emotePanel) composer.emotePanel.hidden = true;
        if (composer.mentionPanel) composer.mentionPanel.hidden = true;
        composer.emojiButton?.setAttribute('aria-expanded', 'false');
        composer.mentionButton?.setAttribute('aria-expanded', 'false');
    }

    function updateMentionSuggestions(panel) {
        const composer = panel?.composer;
        if (!composer || composer.container.hidden) return;

        const mention = composerMentionQuery(composer.textarea);
        if (!mention) {
            hideComposerPopovers(panel);
            return;
        }

        if (!composer.emotePanel.hidden) composer.emotePanel.hidden = true;
        composer.emojiButton.setAttribute('aria-expanded', 'false');
        composer.mentionPanel.hidden = false;
        composer.mentionButton.setAttribute('aria-expanded', 'true');
        scheduleMentionSearch(panel, mention.query);
    }

    async function toggleEmotePanel(panel) {
        const composer = panel?.composer;
        if (!composer || composer.submit.disabled) return;
        const isVisible = !composer.emotePanel.hidden;
        hideComposerPopovers(panel);
        if (isVisible) return;

        composer.emotePanel.hidden = false;
        composer.emojiButton.setAttribute('aria-expanded', 'true');
        composer.textarea.focus();
        if (composer.emotePackages.length) {
            renderEmotePanel(panel, composer.emotePackages);
            return;
        }

        composer.emoteGrid.replaceChildren(createTextElement('div', 'bdv-dialog-emote-empty', '正在加载表情……'));
        const controller = new AbortController();
        state.interactionControllers.add(controller);
        try {
            const packages = await loadEmotePackages(controller.signal);
            if (state.activePanel === panel && !controller.signal.aborted) {
                renderEmotePanel(panel, packages);
            }
        } catch (error) {
            if (state.activePanel === panel && !controller.signal.aborted) {
                composer.emoteGrid.replaceChildren(createTextElement(
                    'div',
                    'bdv-dialog-emote-empty',
                    error?.message || '表情加载失败，请稍后重试'
                ));
            }
        } finally {
            state.interactionControllers.delete(controller);
        }
    }

    function toggleMentionPanel(panel) {
        const composer = panel?.composer;
        if (!composer || composer.submit.disabled) return;
        const isVisible = !composer.mentionPanel.hidden;
        hideComposerPopovers(panel);
        if (isVisible) return;

        if (!composerMentionQuery(composer.textarea)) insertComposerText(composer.textarea, '@');
        composer.mentionPanel.hidden = false;
        composer.mentionButton.setAttribute('aria-expanded', 'true');
        const mention = composerMentionQuery(composer.textarea);
        scheduleMentionSearch(panel, mention?.query || '');
        composer.textarea.focus();
    }

    function createReplyComposer(panel) {
        const form = document.createElement('form');
        form.className = 'bdv-dialog-composer';
        form.hidden = true;
        form.noValidate = true;

        const title = createTextElement('div', 'bdv-dialog-composer-title', '回复评论');
        const textarea = document.createElement('textarea');
        textarea.maxLength = 1000;
        textarea.placeholder = '写下你的回复';
        textarea.setAttribute('aria-label', '回复内容');

        const footer = document.createElement('div');
        footer.className = 'bdv-dialog-composer-footer';
        const toolbar = document.createElement('div');
        toolbar.className = 'bdv-dialog-composer-toolbar';
        const tools = document.createElement('div');
        tools.className = 'bdv-dialog-composer-tools';
        const emojiButton = createTextElement('button', 'bdv-dialog-tool-button', '☺');
        emojiButton.type = 'button';
        emojiButton.title = '插入表情';
        emojiButton.setAttribute('aria-label', '插入表情');
        emojiButton.setAttribute('aria-expanded', 'false');
        const mentionButton = createTextElement('button', 'bdv-dialog-tool-button', '@');
        mentionButton.type = 'button';
        mentionButton.title = '提及用户';
        mentionButton.setAttribute('aria-label', '提及用户');
        mentionButton.setAttribute('aria-expanded', 'false');
        tools.append(emojiButton, mentionButton);
        const count = createTextElement('span', 'bdv-dialog-composer-count', '0/1000');
        toolbar.append(tools, count);

        const buttons = document.createElement('div');
        buttons.className = 'bdv-dialog-composer-buttons';
        const cancel = createTextElement('button', 'bdv-dialog-composer-button', '取消');
        cancel.type = 'button';
        const submit = createTextElement('button', 'bdv-dialog-composer-button bdv-dialog-composer-button--submit', '发送');
        submit.type = 'submit';
        buttons.append(cancel, submit);
        footer.append(toolbar, buttons);

        const emotePanel = document.createElement('div');
        emotePanel.className = 'bdv-dialog-emote-panel';
        emotePanel.hidden = true;
        const emoteTabs = document.createElement('div');
        emoteTabs.className = 'bdv-dialog-emote-tabs';
        const emoteGrid = document.createElement('div');
        emoteGrid.className = 'bdv-dialog-emote-grid';
        emotePanel.append(emoteTabs, emoteGrid);

        const mentionPanel = document.createElement('div');
        mentionPanel.className = 'bdv-dialog-mention-panel';
        mentionPanel.hidden = true;
        const mentionTitle = createTextElement('div', 'bdv-dialog-mention-title', '选择或输入你想@的人');
        const mentionList = document.createElement('div');
        mentionList.className = 'bdv-dialog-mention-list';
        mentionPanel.append(mentionTitle, mentionList);

        form.append(title, textarea, footer, emotePanel, mentionPanel);

        const composer = {
            container: form,
            title,
            textarea,
            count,
            cancel,
            submit,
            emojiButton,
            mentionButton,
            emotePanel,
            emoteTabs,
            emoteGrid,
            emotePackages: [],
            mentionPanel,
            mentionTitle,
            mentionList,
            mentionCandidates: new Map(),
            mentionMap: new Map(),
            searchCandidates: [],
            searchLoading: false,
            searchError: '',
            mentionSearchTimer: null,
            mentionSearchController: null,
            mentionSearchVersion: 0,
            followingCandidates: [],
            followingLoaded: false,
            followingLoading: false,
            target: null
        };

        textarea.addEventListener('input', () => {
            updateComposerCount(composer);
            updateComposerMentionMap(composer);
            updateMentionSuggestions(panel);
        });
        textarea.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && (!emotePanel.hidden || !mentionPanel.hidden)) {
                event.preventDefault();
                hideComposerPopovers(panel);
            }
        });
        emojiButton.addEventListener('click', (event) => {
            event.preventDefault();
            toggleEmotePanel(panel);
        });
        mentionButton.addEventListener('click', (event) => {
            event.preventDefault();
            toggleMentionPanel(panel);
        });
        cancel.addEventListener('click', () => hideReplyComposer(panel));
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            submitReply(panel, textarea.value);
        });

        return composer;
    }

    function showReplyComposer(panel, reply) {
        if (!panel?.composer) return;
        hideComposerPopovers(panel);
        panel.composer.target = reply;
        panel.composer.title.textContent = `回复 @${safeString(reply.member?.uname) || '用户'}`;
        panel.composer.textarea.value = '';
        panel.composer.mentionMap.clear();
        panel.composer.mentionCandidates.clear();
        panel.composer.searchCandidates = [];
        panel.composer.searchError = '';
        rememberMentionCandidates(panel, getMentionCandidates(panel));
        updateComposerCount(panel.composer);
        panel.composer.container.hidden = false;
        panel.composer.textarea.focus();
        panel.composer.container.scrollIntoView?.({ block: 'nearest' });
    }

    function hideReplyComposer(panel) {
        if (!panel?.composer) return;
        hideComposerPopovers(panel);
        panel.composer.target = null;
        panel.composer.textarea.value = '';
        updateComposerCount(panel.composer);
        panel.composer.container.hidden = true;
        panel.composer.submit.disabled = false;
        panel.composer.cancel.disabled = false;
    }

    function showPanelNotice(panel, message) {
        if (!panel?.body) return;
        const previous = panel.body.querySelector('.bdv-dialog-notice');
        previous?.remove();
        const notice = createTextElement('div', 'bdv-dialog-notice bdv-dialog-error', message);
        panel.body.prepend(notice);
        window.setTimeout(() => notice.isConnected && notice.remove(), 4500);
    }

    function renderDialogItems(panel, replies, info) {
        const body = panel.body;
        const currentRpid = info.rpid;
        panel.replies = replies;
        panel.info = info;
        panel.items = new Map();
        body.replaceChildren();
        hideReplyComposer(panel);

        if (!replies.length) {
            body.appendChild(createTextElement('div', 'bdv-dialog-status', '没有找到可显示的对话内容'));
            return;
        }

        const fragment = document.createDocumentFragment();
        for (const reply of replies) {
            const item = document.createElement('article');
            item.className = 'bdv-dialog-item';
            item.dataset.current = reply.rpid === currentRpid ? 'true' : 'false';
            item.dataset.rpid = reply.rpid;

            const avatar = document.createElement('img');
            avatar.className = 'bdv-dialog-avatar';
            avatar.alt = safeString(reply.member?.uname) || '用户头像';
            avatar.loading = 'lazy';
            const avatarUrl = toSafeUrl(reply.member?.avatar || reply.member?.face);
            if (avatarUrl) avatar.src = avatarUrl;

            const avatarHref = profileHref(reply.mid || reply.member?.mid);
            const avatarHolder = document.createElement(avatarHref ? 'a' : 'div');
            avatarHolder.className = 'bdv-dialog-avatar-link';
            if (avatarHref) {
                avatarHolder.href = avatarHref;
                avatarHolder.target = '_blank';
                avatarHolder.rel = 'noopener noreferrer';
                avatarHolder.title = `打开 ${safeString(reply.member?.uname) || '用户'} 的个人空间`;
            }
            avatarHolder.appendChild(avatar);

            const main = document.createElement('div');
            main.className = 'bdv-dialog-main';
            const user = document.createElement('div');
            user.className = 'bdv-dialog-user';

            const username = document.createElement(avatarHref ? 'a' : 'span');
            username.className = avatarHref ? 'bdv-dialog-username-link' : 'bdv-dialog-username-text';
            username.textContent = safeString(reply.member?.uname) || '匿名用户';
            if (avatarHref) {
                username.href = avatarHref;
                username.target = '_blank';
                username.rel = 'noopener noreferrer';
            }
            const nicknameColor = validColor(reply.member?.vip?.nickname_color);
            if (nicknameColor) username.style.color = nicknameColor;
            user.appendChild(username);

            const level = createLevelBadge(reply);
            if (level) user.appendChild(level);

            if (item.dataset.current === 'true') {
                user.appendChild(createTextElement('span', 'bdv-dialog-current', '当前回复'));
            }

            const message = createTextElement('div', 'bdv-dialog-message', '');
            renderMessageContent(message, reply);

            const meta = document.createElement('div');
            meta.className = 'bdv-dialog-meta';
            meta.appendChild(createTextElement('span', '', formatTime(reply.ctime)));
            if (reply.location) {
                const location = reply.location.startsWith('IP属地') ? reply.location : `IP属地：${reply.location}`;
                meta.appendChild(createTextElement('span', '', location));
            }
            const like = createActionButton('like', panel, reply);
            const dislike = createActionButton('dislike', panel, reply);
            const replyButton = createActionButton('reply', panel, reply);
            meta.append(like.button, dislike.button, replyButton.button);

            main.appendChild(user);
            main.appendChild(message);
            main.appendChild(meta);
            item.appendChild(avatarHolder);
            item.appendChild(main);
            fragment.appendChild(item);
            panel.items.set(reply.rpid, { reply, item, like, dislike, replyButton });
        }
        body.appendChild(fragment);
        if (replies.truncated) {
            body.appendChild(createTextElement(
                'div',
                'bdv-dialog-status bdv-dialog-error',
                '对话较长，已达到加载上限，列表可能不是完整内容'
            ));
        }
    }

    function createPanel() {
        ensureGlobalStyles();

        const overlay = document.createElement('div');
        overlay.className = 'bdv-dialog-overlay';
        overlay.setAttribute('role', 'presentation');

        const panel = document.createElement('section');
        panel.className = 'bdv-dialog-panel';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        panel.setAttribute('aria-labelledby', 'bdv-dialog-title');

        const header = document.createElement('header');
        header.className = 'bdv-dialog-header';
        const title = createTextElement('div', '', '对话列表');
        title.id = 'bdv-dialog-title';
        const close = document.createElement('button');
        close.className = 'bdv-dialog-close';
        close.type = 'button';
        close.setAttribute('aria-label', '关闭对话列表');
        close.textContent = '×';
        header.appendChild(title);
        header.appendChild(close);

        const body = document.createElement('div');
        body.className = 'bdv-dialog-body';
        body.appendChild(createTextElement('div', 'bdv-dialog-status', '正在加载对话……'));

        panel.appendChild(header);
        panel.appendChild(body);

        const panelState = {
            overlay,
            panel,
            body,
            close,
            info: null,
            replies: [],
            items: new Map(),
            composer: null
        };
        panelState.composer = createReplyComposer(panelState);
        panel.appendChild(panelState.composer.container);
        overlay.appendChild(panel);
        document.body.appendChild(overlay);

        const closePanel = () => closeDialogPanel();
        close.addEventListener('click', closePanel);
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) closePanel();
        });

        return panelState;
    }

    function closeDialogPanel() {
        if (state.activeAbortController) {
            state.activeAbortController.abort();
            state.activeAbortController = null;
        }
        for (const controller of state.interactionControllers) controller.abort();
        state.interactionControllers.clear();
        cancelMentionSearch(state.activePanel?.composer);
        if (state.activePanel?.overlay?.isConnected) {
            state.activePanel.overlay.remove();
        }
        state.activePanel = null;
    }

    function handleGlobalKeydown(event) {
        if (event.key !== 'Escape' || !state.activePanel) return;
        const composer = state.activePanel.composer;
        if (composer && (!composer.emotePanel.hidden || !composer.mentionPanel.hidden)) {
            event.preventDefault();
            event.stopPropagation();
            hideComposerPopovers(state.activePanel);
            return;
        }
        closeDialogPanel();
    }

    async function fetchPageCommentTarget(signal) {
        const pageContext = getPageContext();
        if (pageContext.oid) return pageContext.oid;

        const stateAid = extractAidFromPageState();
        if (stateAid) return stateAid;

        const bvid = extractBvidFromUrl();
        if (!bvid) return '';

        const url = new URL(`${CONFIG.apiBase}/x/web-interface/view`);
        url.searchParams.set('bvid', bvid);
        const response = await fetch(url, {
            credentials: 'include',
            signal,
            headers: { Accept: 'application/json' }
        });
        if (!response.ok) throw new Error(`视频信息请求失败（HTTP ${response.status}）`);
        const data = await response.json();
        if (Number(data?.code) !== 0) throw new Error(data?.message || '无法获取视频 AID');
        return firstString(data?.data?.aid);
    }

    async function resolveOid(info, signal) {
        if (info.oid) return info.oid;
        if (!state.pageTargetPromise) {
            state.pageTargetPromise = fetchPageCommentTarget(signal).catch((error) => {
                state.pageTargetPromise = null;
                throw error;
            });
        }
        return state.pageTargetPromise;
    }

    function getCsrfToken() {
        const names = new Set(['bili_jct', 'csrf']);
        for (const part of document.cookie.split(';')) {
            const separator = part.indexOf('=');
            if (separator < 0) continue;
            const name = part.slice(0, separator).trim();
            if (!names.has(name)) continue;
            const value = part.slice(separator + 1).trim();
            try {
                return decodeURIComponent(value);
            } catch (_) {
                return value;
            }
        }
        return '';
    }

    async function postForm(path, params, signal) {
        const csrf = getCsrfToken();
        if (!csrf) throw new Error('未找到 bili_jct，请先登录 B 站后再操作');

        const form = new URLSearchParams();
        for (const [key, value] of Object.entries(params)) {
            if (value !== undefined && value !== null) form.set(key, String(value));
        }
        form.set('csrf', csrf);

        const response = await fetch(`${CONFIG.apiBase}${path}`, {
            method: 'POST',
            credentials: 'include',
            signal,
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
            },
            body: form.toString()
        });
        if (!response.ok) throw new Error(`评论操作失败（HTTP ${response.status}）`);
        const json = await response.json();
        if (Number(json?.code) !== 0) {
            throw new Error(json?.message || `评论操作失败（${json?.code ?? '未知'}）`);
        }
        return json;
    }

    function dialogCacheKey(info, oid) {
        return `${safeString(info.type)}:${oid || info.oid || ''}:${info.root}:${info.dialog}`;
    }

    function updateReplyAfterAction(reply, kind, requestedAction) {
        const previousAction = reply.action;
        if (kind === 'like') {
            if (requestedAction === 1 && previousAction !== 1) reply.like += 1;
            if (requestedAction === 0 && previousAction === 1) reply.like = Math.max(0, reply.like - 1);
            reply.action = requestedAction === 1 ? 1 : 0;
            return;
        }

        if (requestedAction === 1 && previousAction === 1) {
            reply.like = Math.max(0, reply.like - 1);
        }
        reply.action = requestedAction === 1 ? 2 : 0;
    }

    async function toggleReplyAction(panel, reply, kind, control) {
        if (!panel?.info || !control || control.button.getAttribute('aria-busy') === 'true') return;

        const currentAction = kind === 'like' ? reply.action === 1 : reply.action === 2;
        const requestedAction = currentAction ? 0 : 1;
        const controller = new AbortController();
        state.interactionControllers.add(controller);
        control.button.setAttribute('aria-busy', 'true');

        try {
            const info = { ...panel.info, oid: reply.oid || panel.info.oid, type: reply.type || panel.info.type };
            const type = requireCommentType(info);
            const oid = await resolveOid(info, controller.signal);
            await postForm(
                kind === 'like' ? '/x/v2/reply/action' : '/x/v2/reply/hate',
                { type, oid, rpid: reply.rpid, action: requestedAction },
                controller.signal
            );
            updateReplyAfterAction(reply, kind, requestedAction);
            const entry = panel.items.get(reply.rpid);
            updateActionControl(entry?.like, reply);
            updateActionControl(entry?.dislike, reply);
        } catch (error) {
            if (!controller.signal.aborted && state.activePanel === panel) {
                showPanelNotice(panel, error?.message || '评论操作失败');
            }
        } finally {
            state.interactionControllers.delete(controller);
            if (control.button.isConnected) control.button.setAttribute('aria-busy', 'false');
        }
    }

    async function submitReply(panel, message) {
        const composer = panel?.composer;
        const target = composer?.target;
        const text = safeString(message);
        if (!panel?.info || !target || composer.submit.disabled) return;
        if (!text) {
            showPanelNotice(panel, '回复内容不能为空');
            composer.textarea.focus();
            return;
        }
        if (Array.from(text).length > 1000) {
            showPanelNotice(panel, '回复内容不能超过 1000 字');
            return;
        }

        const controller = new AbortController();
        state.interactionControllers.add(controller);
        composer.submit.disabled = true;
        composer.cancel.disabled = true;
        composer.title.textContent = '正在发送回复……';

        try {
            const info = { ...panel.info, oid: target.oid || panel.info.oid, type: target.type || panel.info.type };
            const type = requireCommentType(info);
            const oid = await resolveOid(info, controller.signal);
            await postForm('/x/v2/reply/add', {
                type,
                oid,
                root: info.root || target.root,
                parent: target.rpid,
                message: text,
                at_name_to_mid: JSON.stringify(getComposerAtNameToMid(composer)),
                plat: 1
            }, controller.signal);

            state.dialogCache.delete(dialogCacheKey(info, oid));
            hideReplyComposer(panel);
            try {
                const replies = await fetchAllDialog({ ...info, oid }, controller.signal);
                if (state.activePanel === panel && !controller.signal.aborted) {
                    renderDialogItems(panel, replies, { ...info, oid });
                    showPanelNotice(panel, '回复已发送');
                }
            } catch (refreshError) {
                if (!controller.signal.aborted && state.activePanel === panel) {
                    showPanelNotice(panel, `回复已发送，但刷新失败：${refreshError?.message || '请稍后重试'}`);
                }
            }
        } catch (error) {
            if (!controller.signal.aborted && state.activePanel === panel) {
                composer.submit.disabled = false;
                composer.cancel.disabled = false;
                composer.title.textContent = `回复 @${safeString(target.member?.uname) || '用户'}`;
                showPanelNotice(panel, error?.message || '回复发送失败');
            }
        } finally {
            state.interactionControllers.delete(controller);
            if (state.activePanel === panel && !composer.container.hidden && composer.submit.disabled) {
                composer.submit.disabled = false;
                composer.cancel.disabled = false;
            }
        }
    }

    async function fetchDialogPage(info, minFloor, signal) {
        const type = requireCommentType(info);
        const oid = await resolveOid(info, signal);
        if (!oid) throw new Error('缺少评论区 ID');

        const url = new URL(`${CONFIG.apiBase}/x/v2/reply/dialog/cursor`);
        url.searchParams.set('type', type);
        url.searchParams.set('oid', oid);
        url.searchParams.set('root', info.root);
        url.searchParams.set('dialog', info.dialog);
        url.searchParams.set('size', String(CONFIG.pageSize));
        url.searchParams.set('min_floor', String(minFloor));

        const timeoutController = new AbortController();
        const timeoutId = window.setTimeout(() => timeoutController.abort(), CONFIG.requestTimeoutMs);
        const abortForwarder = () => timeoutController.abort();
        if (signal?.aborted) timeoutController.abort();
        signal?.addEventListener('abort', abortForwarder, { once: true });

        try {
            const response = await fetch(url, {
                credentials: 'include',
                signal: timeoutController.signal,
                headers: { Accept: 'application/json' }
            });
            if (!response.ok) throw new Error(`对话请求失败（HTTP ${response.status}）`);
            const json = await response.json();
            if (Number(json?.code) !== 0) {
                throw new Error(json?.message || `对话接口返回错误（${json?.code ?? '未知'}）`);
            }
            return json.data || {};
        } catch (error) {
            if (error?.name === 'AbortError') {
                throw new Error('对话请求超时或已取消');
            }
            throw error;
        } finally {
            window.clearTimeout(timeoutId);
            signal?.removeEventListener('abort', abortForwarder);
        }
    }

    async function fetchAllDialog(info, signal) {
        const resolvedOid = await resolveOid(info, signal);
        const cacheKey = dialogCacheKey(info, resolvedOid);
        const cached = state.dialogCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < CONFIG.cacheTtlMs) return cached.replies;

        const replies = [];
        const seen = new Set();
        let minFloor = 0;
        let previousMaxFloor = -1;
        let dialogMaxFloor = null;
        let reachedDialogEnd = false;

        for (let page = 0; page < CONFIG.maxPages; page += 1) {
            const data = await fetchDialogPage({ ...info, oid: resolvedOid }, minFloor, signal);
            const pageReplies = Array.isArray(data.replies) ? data.replies : [];
            for (const rawReply of pageReplies) {
                const reply = normalizeReplyData(rawReply, resolvedOid, info.type);
                if (reply && !seen.has(reply.rpid)) {
                    seen.add(reply.rpid);
                    replies.push(reply);
                }
            }

            const cursorMax = Number(data.cursor?.max_floor);
            const currentDialogMax = Number(data.dialog?.max_floor);
            if (Number.isFinite(currentDialogMax)) dialogMaxFloor = currentDialogMax;
            if (!Number.isFinite(cursorMax)) {
                reachedDialogEnd = true;
                break;
            }
            if (cursorMax <= previousMaxFloor) {
                reachedDialogEnd = true;
                break;
            }
            previousMaxFloor = cursorMax;
            if (dialogMaxFloor !== null && cursorMax >= dialogMaxFloor) {
                reachedDialogEnd = true;
                break;
            }

            const nextFloor = cursorMax + 1;
            if (!Number.isSafeInteger(nextFloor) || nextFloor <= minFloor) break;
            minFloor = nextFloor;
        }

        if (!reachedDialogEnd) {
            Object.defineProperty(replies, 'truncated', {
                value: true,
                enumerable: false,
                configurable: true
            });
        }

        state.dialogCache.set(cacheKey, { timestamp: Date.now(), replies });
        while (state.dialogCache.size > CONFIG.maxDialogCacheEntries) {
            const oldestKey = state.dialogCache.keys().next().value;
            if (oldestKey === undefined) break;
            state.dialogCache.delete(oldestKey);
        }
        return replies;
    }

    async function openDialogPanel(info, sourceLink) {
        closeDialogPanel();
        const panel = createPanel();
        state.activePanel = panel;
        const controller = new AbortController();
        state.activeAbortController = controller;
        state.interactionControllers.add(controller);
        sourceLink?.setAttribute('aria-busy', 'true');

        try {
            const resolvedOid = await resolveOid(info, controller.signal);
            const panelInfo = { ...info, oid: resolvedOid };
            const replies = await fetchAllDialog(panelInfo, controller.signal);
            if (state.activePanel !== panel || controller.signal.aborted) return;
            renderDialogItems(panel, replies, panelInfo);
        } catch (error) {
            if (state.activePanel !== panel || controller.signal.aborted) return;
            panel.body.replaceChildren();
            const status = createTextElement('div', 'bdv-dialog-status bdv-dialog-error', error?.message || '对话加载失败');
            panel.body.appendChild(status);
        } finally {
            state.interactionControllers.delete(controller);
            if (sourceLink?.isConnected) sourceLink.removeAttribute('aria-busy');
            if (state.activeAbortController === controller) state.activeAbortController = null;
        }
    }

    function handleRouteChange() {
        if (location.href === state.routeKey) return;
        state.routeKey = location.href;
        state.pageTargetPromise = null;
        state.emotePromise = null;
        state.followingPromise = null;
        state.pageMentionCandidates.clear();
        state.dialogCache.clear();
        closeDialogPanel();
        scheduleFullScan();
    }

    function init() {
        if (state.initialized) return;
        state.initialized = true;
        document.addEventListener('keydown', handleGlobalKeydown, true);
        window.addEventListener('popstate', handleRouteChange, true);
        window.addEventListener('hashchange', handleRouteChange, true);
        state.scanInterval = window.setInterval(() => {
            handleRouteChange();
            // 低频全量扫描只作为属性更新、ShadowRoot 重建等场景的兜底。
            scheduleFullScan();
        }, CONFIG.scanIntervalMs);
        ensureGlobalStyles();
        scheduleFullScan();
    }

    init();
})();

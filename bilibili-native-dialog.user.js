// ==UserScript==
// @name         bilibili类原生查看对话
// @namespace    https://github.com/nsdd/bilibili-native-dialog
// @version      0.5.3
// @author       luolisama
// @downloadURL  https://raw.githubusercontent.com/luolisama/bilibili-native-dialog/main/bilibili-native-dialog.user.js
// @updateURL    https://raw.githubusercontent.com/luolisama/bilibili-native-dialog/main/bilibili-native-dialog.user.js
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
        pageType: '1',
        pageSize: 20,
        maxPages: 100,
        cacheTtlMs: 3 * 60 * 1000,
        scanDebounceMs: 180,
        scanIntervalMs: 1800,
        requestTimeoutMs: 15000,
        apiBase: 'https://api.bilibili.com'
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
        rootObservers: new WeakMap(),
        scanTimer: null,
        scanInterval: null,
        scanning: false,
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

    function log(level, ...args) {
        if (level === 'error') {
            console.error('[bilibili类原生查看对话]', ...args);
        }
    }

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
            fallbackType,
            CONFIG.pageType
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
            location: firstString(control.location, raw.location),
            raw
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
        if (!root || state.styledRoots.has(root)) return;
        state.styledRoots.add(root);

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
        if (!info || !info.rpid || !info.root || info.root === '0') return;
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

    function observeRoot(root) {
        if (!root || state.observedRoots.has(root)) return;
        state.observedRoots.add(root);

        const observer = new MutationObserver(() => scheduleScan());
        try {
            observer.observe(root, { childList: true, subtree: true });
            state.rootObservers.set(root, observer);
        } catch (_) {
            state.observedRoots.delete(root);
        }
    }

    function visitRoot(root) {
        if (!root?.querySelectorAll) return;
        observeRoot(root);

        for (const element of root.querySelectorAll('*')) {
            if (isReplyHost(element)) processReplyHost(element);
            if (element.shadowRoot) visitRoot(element.shadowRoot);
        }
    }

    function scan() {
        if (state.scanning) return;
        state.scanning = true;
        try {
            visitRoot(document);
        } finally {
            state.scanning = false;
        }
    }

    function scheduleScan() {
        if (state.scanTimer) return;
        state.scanTimer = window.setTimeout(() => {
            state.scanTimer = null;
            scan();
        }, CONFIG.scanDebounceMs);
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
                fon…17334 tokens truncated…og-avatar';
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
        return `${info.type || CONFIG.pageType}:${oid || info.oid || ''}:${info.root}:${info.dialog}`;
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
            const oid = await resolveOid(info, controller.signal);
            await postForm(
                kind === 'like' ? '/x/v2/reply/action' : '/x/v2/reply/hate',
                { type: info.type || CONFIG.pageType, oid, rpid: reply.rpid, action: requestedAction },
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
            const oid = await resolveOid(info, controller.signal);
            await postForm('/x/v2/reply/add', {
                type: info.type || CONFIG.pageType,
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
        const oid = await resolveOid(info, signal);
        if (!oid) throw new Error('缺少评论区 ID');

        const url = new URL(`${CONFIG.apiBase}/x/v2/reply/dialog/cursor`);
        url.searchParams.set('type', info.type || CONFIG.pageType);
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
            if (!Number.isFinite(cursorMax)) break;
            if (cursorMax <= previousMaxFloor) break;
            previousMaxFloor = cursorMax;
            if (dialogMaxFloor !== null && cursorMax >= dialogMaxFloor) break;

            const nextFloor = cursorMax + 1;
            if (!Number.isSafeInteger(nextFloor) || nextFloor <= minFloor) break;
            minFloor = nextFloor;
        }

        state.dialogCache.set(cacheKey, { timestamp: Date.now(), replies });
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
        scheduleScan();
    }

    function init() {
        if (state.initialized) return;
        state.initialized = true;
        document.addEventListener('keydown', handleGlobalKeydown, true);
        window.addEventListener('popstate', handleRouteChange, true);
        window.addEventListener('hashchange', handleRouteChange, true);
        state.scanInterval = window.setInterval(() => {
            handleRouteChange();
            scheduleScan();
        }, CONFIG.scanIntervalMs);
        ensureGlobalStyles();
        scheduleScan();
    }

    init();
})();


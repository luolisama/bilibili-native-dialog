<div align="center">

# bilibili类原生查看对话

让 B 站网页端也能像客户端一样查看完整的评论对话。

[![直接安装](https://img.shields.io/badge/%E7%9B%B4%E6%8E%A5%E5%AE%89%E8%A3%85-%E7%82%B9%E5%87%BB%E5%AE%89%E8%A3%85-00A1D6?style=for-the-badge&logo=tampermonkey&logoColor=white)](https://raw.githubusercontent.com/luolisama/bilibili-native-dialog/main/bilibili-native-dialog.user.js)

<sub>点击上方按钮后，用户脚本管理器会自动打开安装页面。</sub>

</div>

## 使用前准备

- 使用 Chrome、Edge、Firefox 或其他现代浏览器。
- 安装 [Tampermonkey](https://www.tampermonkey.net/) 或 [Violentmonkey](https://violentmonkey.github.io/) 任一用户脚本管理器。
- 登录 B 站后使用，点赞、点踩和回复等操作才能正常工作。

## 安装

1. 先安装 Tampermonkey 或 Violentmonkey。
2. 点击页面顶部的「直接安装」按钮。
3. 在弹出的用户脚本页面中点击「安装」或「确认安装」。
4. 打开或刷新 B 站页面即可生效。

## 怎么使用

1. 打开 B 站视频、动态、文章等有评论区的页面。
2. 找到一条回复了其他评论的评论。
3. 点击评论操作栏中的「查看对话」。
4. 在弹出的对话列表中，可以按时间顺序查看这条评论相关的完整对话。

对话列表会尽量保持 B 站评论区的使用习惯：头像可以进入个人主页，等级标识、点赞、点踩和回复都可以直接操作；回复时还可以使用表情和 `@` 选择用户。

## 其他说明

- 支持 B 站网页端常见的评论页面，包括视频、动态和专栏文章。
- 如果评论区没有出现「查看对话」，通常是当前评论没有形成多人对话，或评论内容还没有加载完成。
- 如果页面同时启用了其他会整体修改 B 站评论区的脚本，出现显示冲突时可以暂时关闭其中一个再刷新页面。

## 卸载

在 Tampermonkey 或 Violentmonkey 的脚本列表中找到「bilibili类原生查看对话」，关闭开关即可停用；也可以从脚本管理器中直接删除。

<div align="center">

[⬇️ 再次安装](https://raw.githubusercontent.com/luolisama/bilibili-native-dialog/main/bilibili-native-dialog.user.js) · [查看源代码](https://github.com/luolisama/bilibili-native-dialog/blob/main/bilibili-native-dialog.user.js)

</div>

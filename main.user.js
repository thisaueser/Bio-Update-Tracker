// ==UserScript==
// @name         Bio Update Tracker
// @name:zh      bio更新检测
// @namespace    https://www.bondageprojects.com/
// @version      1.0.0
// @description  （重要提示：需要启用 WCE 的 “保存并浏览已知的个人资料（需要刷新）” 选项）自动提醒查看bio的更新，并高亮显示变化部分
// @author       Wuhu
// @match        https://bondageprojects.elementfx.com/*
// @match        https://www.bondageprojects.elementfx.com/*
// @match        https://bondage-europe.com/*
// @match        https://www.bondage-europe.com/*
// @match        https://bondage-asia.com/*
// @match        https://www.bondage-asia.com/*
// @require      https://unpkg.com/idb@8.0.3/build/umd.js
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // 工具函数

    function safeJSONParse(str) {
        try {
            return JSON.parse(str);
        } catch (e) {
            console.error('[BioTracker] JSON parse failed:', e);
            return null;
        }
    }

    function decompressIfNeeded(str) {
        if (
            typeof str === 'string' &&
            str.startsWith(ONLINE_PROFILE_DESCRIPTION_COMPRESSION_MAGIC)
        ) {
            try {
                return LZString.decompressFromUTF16(str.substring(1));
            } catch (e) {
                // console.warn('[BioTracker] decompress failed:', e);
                return null;
            }
        }
        return null;
    }

    // Diff UI

    const DiffPro = (() => {
        let root = null;
        let keyHandler = null;
        let unbindScroll = null;
        let isDark = true;

        function myersDiff(a, b) {
            const A = a.split('\n');
            const B = b.split('\n');

            const N = A.length;
            const M = B.length;
            const MAX = N + M;

            const v = {};
            v[1] = 0;

            const trace = [];

            for (let d = 0; d <= MAX; d++) {
                trace.push({ ...v });

                for (let k = -d; k <= d; k += 2) {
                    let x;

                    if (k === -d || (k !== d && v[k - 1] < v[k + 1])) {
                        x = v[k + 1];
                    } else {
                        x = v[k - 1] + 1;
                    }

                    let y = x - k;

                    while (x < N && y < M && A[x] === B[y]) {
                        x++;
                        y++;
                    }

                    v[k] = x;

                    if (x >= N && y >= M) {
                        return backtrack(trace, A, B);
                    }
                }
            }
        }

        function backtrack(trace, A, B) {
            let x = A.length;
            let y = B.length;
            const out = [];

            for (let d = trace.length - 1; d >= 0; d--) {
                const v = trace[d];
                const k = x - y;

                let prevK;

                if (k === -d || (k !== d && v[k - 1] < v[k + 1])) {
                    prevK = k + 1;
                } else {
                    prevK = k - 1;
                }

                const prevX = v[prevK];
                const prevY = prevX - prevK;

                while (x > prevX && y > prevY) {
                    out.unshift({ type: 'ctx', text: A[x - 1] });
                    x--;
                    y--;
                }

                if (d === 0) break;

                if (x === prevX) {
                    out.unshift({ type: 'add', text: B[y - 1] });
                    y--;
                } else {
                    out.unshift({ type: 'del', text: A[x - 1] });
                    x--;
                }
            }

            return out;
        }

        function charDiff(a, b) {
            const A = a.split('');
            const B = b.split('');

            const dp = Array(A.length + 1)
                .fill(0)
                .map(() => Array(B.length + 1).fill(0));

            for (let i = 1; i <= A.length; i++) {
                for (let j = 1; j <= B.length; j++) {
                    dp[i][j] =
                        A[i - 1] === B[j - 1]
                            ? dp[i - 1][j - 1] + 1
                            : Math.max(dp[i - 1][j], dp[i][j - 1]);
                }
            }

            let i = A.length,
                j = B.length;
            let oldHTML = '',
                newHTML = '';

            while (i > 0 || j > 0) {
                if (i > 0 && j > 0 && A[i - 1] === B[j - 1]) {
                    oldHTML = A[i - 1] + oldHTML;
                    newHTML = B[j - 1] + newHTML;
                    i--;
                    j--;
                } else if (
                    j > 0 &&
                    (i === 0 || dp[i][j - 1] >= dp[i - 1][j])
                ) {
                    newHTML =
                        `<span class="add-inline">${B[j - 1]}</span>` +
                        newHTML;
                    j--;
                } else {
                    oldHTML =
                        `<span class="del-inline">${A[i - 1]}</span>` +
                        oldHTML;
                    i--;
                }
            }

            return { oldHTML, newHTML };
        }

        function createUI() {
            root = document.createElement('div');
            document.body.appendChild(root);

            const shadow = root.attachShadow({ mode: 'open' });

            shadow.innerHTML = `
    <style>
    :host {
    --bg: #0d1117;
    --fg: #c9d1d9;
    --add-bg: #12261e;
    --add-inline: #2ea043;
    --del-bg: #2b1d1d;
    --del-inline: #f85149;
    }

    :host(.light) {
    --bg: #ffffff;
    --fg: #111;
    --add-bg: #e6ffec;
    --add-inline: #acf2bd;
    --del-bg: #ffebe9;
    --del-inline: #ffc1c0;
    }

    .wrapper {
    position: fixed;
    inset: 0;
    background: var(--bg);
    color: var(--fg);
    font-family: monospace;
    display: flex;
    flex-direction: column;
    z-index: 999999;
    }

    .header {
    height: 44px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0 10px;
    border-bottom: 1px solid #30363d;
    }

    .content {
    flex: 1;
    display: flex;
    overflow: hidden;
    }

    .panel {
    width: 50%;
    overflow: auto;
    font-size: 14px;
    line-height: 18px;
    }

    .row {
    display: flex;
    min-height: 18px;
    width: max-content;
    min-width: 100%;
    }

    .ln {
    width: 50px;
    text-align: right;
    padding-right: 8px;
    color: #8b949e;
    flex-shrink: 0;
    }

    .code {
    white-space: pre;
    padding: 0 8px;
    min-width: 0;
    }

    .add { background: var(--add-bg); }
    .del { background: var(--del-bg); }
    .add-inline { background: var(--add-inline); }
    .del-inline { background: var(--del-inline); }

    .empty .code {
    height: 18px;
    }

    .close, .theme {
    cursor: pointer;
    margin-left: 10px;
    }
    </style>

    <div class="wrapper">
    <div class="header">
        <div>Diff Viewer</div>
        <div>
        <span class="theme" id="themeBtn">🌓</span>
        <span class="close" id="closeBtn">✕</span>
        </div>
    </div>

    <div class="content">
        <div class="panel" id="left"></div>
        <div class="panel" id="right"></div>
    </div>
    </div>
    `;

            return shadow;
        }

        function syncScroll(a, b) {
            let lock = false;

            function sync(from, to) {
                if (lock) return;
                lock = true;

                const maxFrom = from.scrollHeight - from.clientHeight;
                const maxTo = to.scrollHeight - to.clientHeight;

                const ratio = maxFrom <= 0 ? 0 : from.scrollTop / maxFrom;

                to.scrollTop = ratio * maxTo;
                to.scrollLeft = from.scrollLeft;

                lock = false;
            }

            function onA() {
                sync(a, b);
            }

            function onB() {
                sync(b, a);
            }

            a.addEventListener('scroll', onA);
            b.addEventListener('scroll', onB);

            return () => {
                a.removeEventListener('scroll', onA);
                b.removeEventListener('scroll', onB);
            };
        }

        function equalizeHeight(left, right) {
            const max = Math.max(left.children.length, right.children.length);

            while (left.children.length < max) {
                left.appendChild(makeRow('', '', 'empty'));
            }

            while (right.children.length < max) {
                right.appendChild(makeRow('', '', 'empty'));
            }
        }

        function makeRow(line, text, type = '') {
            const row = document.createElement('div');
            row.className = 'row ' + type;

            const ln = document.createElement('div');
            ln.className = 'ln';
            ln.textContent = line;

            const code = document.createElement('div');
            code.className = 'code';
            code.innerHTML = text;

            row.appendChild(ln);
            row.appendChild(code);

            return row;
        }

        function destroy() {
            if (keyHandler) {
                window.removeEventListener('keydown', keyHandler, true);
                keyHandler = null;
            }

            if (unbindScroll) {
                unbindScroll();
                unbindScroll = null;
            }

            root?.remove();
            root = null;
        }

        function render(oldStr, newStr) {
            const shadow = createUI();

            const host = root.shadowRoot.host;
            const left = shadow.getElementById('left');
            const right = shadow.getElementById('right');

            shadow.getElementById('closeBtn').onclick = destroy;

            shadow.getElementById('themeBtn').onclick = () => {
                isDark = !isDark;
                host.classList.toggle('light', !isDark);
            };

            const diff = myersDiff(oldStr, newStr);

            let l = 1,
                r = 1;

            for (let i = 0; i < diff.length; i++) {
                let delBlock = [];
                let addBlock = [];

                while (i < diff.length && diff[i].type === 'del') {
                    delBlock.push(diff[i]);
                    i++;
                }
                while (i < diff.length && diff[i].type === 'add') {
                    addBlock.push(diff[i]);
                    i++;
                }

                if (delBlock.length > 0 || addBlock.length > 0) {
                    const max = Math.max(delBlock.length, addBlock.length);
                    for (let j = 0; j < max; j++) {
                        const d = delBlock[j];
                        const a = addBlock[j];

                        if (d && a) {
                            const cd = charDiff(d.text, a.text);
                            left.appendChild(makeRow(l++, cd.oldHTML, 'del'));
                            right.appendChild(makeRow(r++, cd.newHTML, 'add'));
                        } else if (d) {
                            left.appendChild(makeRow(l++, d.text, 'del'));
                            right.appendChild(makeRow('', '', 'empty'));
                        } else if (a) {
                            left.appendChild(makeRow('', '', 'empty'));
                            right.appendChild(makeRow(r++, a.text, 'add'));
                        }
                    }
                    i--;
                    continue;
                }

                const d = diff[i];
                if (d.type === 'ctx') {
                    left.appendChild(makeRow(l++, d.text));
                    right.appendChild(makeRow(r++, d.text));
                }
            }

            equalizeHeight(left, right);

            unbindScroll = syncScroll(left, right);

            keyHandler = (e) => {
                if (
                    e.key === 'Escape' ||
                    (e.altKey && e.key === 'q') ||
                    (e.ctrlKey && e.shiftKey && e.key === 'd')
                ) {
                    destroy();
                }
            };

            window.addEventListener('keydown', keyHandler, true);
        }

        return {
            show(a, b) {
                destroy();
                render(a, b);
            },
        };
    })();

    // Bio逻辑

    const processedMap = new Map();
    const CACHE_TIME = 10000;

    function shouldProcess(memberNumber) {
        const now = Date.now();
        const last = processedMap.get(memberNumber);

        if (last && now - last < CACHE_TIME) return false;

        processedMap.set(memberNumber, now);
        return true;
    }

    function extractDescription(data) {
        if (!data?.characterBundle) return null;

        const parsed = safeJSONParse(data.characterBundle);
        if (!parsed || typeof parsed.Description !== 'string') return null;

        const raw = parsed.Description;
        const decompressed = decompressIfNeeded(raw);

        return decompressed ?? raw;
    }

    async function compareBio(db, char) {
        const oldData = await db.get('profiles', char.MemberNumber);
        if (!oldData) return;

        const oldDesc = extractDescription(oldData) || '';
        const newRaw = char.Description || '';
        const newDesc = decompressIfNeeded(newRaw) ?? newRaw;

        if (oldDesc === newDesc) return;

        const name = char.Nickname || char.Name;

        const line = document.createElement('span');
        line.textContent = `bio更新：${name} (${char.MemberNumber})   `;

        const link = document.createElement('a');
        link.textContent = '查看变化';
        link.href = '#';

        link.addEventListener('click', (e) => {
            e.preventDefault();
            DiffPro.show(oldDesc, newDesc);
        });

        line.appendChild(link);
        fbcChatNotify([line]);
    }

    // SDK 初始化

    function waitForSdk() {
        if (!window.bcModSdk) {
            setTimeout(waitForSdk, 1000);
            return;
        }
        init();
    }

    async function init() {
        const mod = window.bcModSdk.registerMod({
            name: 'Bio Update Tracker',
            fullName: 'Bio Update Tracker',
            version: '1.0.0',
            repository: 'https://github.com/thisaueser/Bio-Update-Tracker'
        });

        const db = await idb.openDB('bce-past-profiles');

        function handleCharacter(char) {
            if (shouldProcess(char.MemberNumber)) {
                compareBio(db, char);
            }
        }

        try {
            mod.hookFunction('ChatRoomSyncSingle', 12, (args, next) => {
                const data = args[0];
                if (data?.Character) handleCharacter(data.Character);
                return next(args);
            });
        } catch (e) {
            console.warn('Hook ChatRoomSyncSingle 失败:', e);
        }

        try {
            mod.hookFunction('ChatRoomSync', 12, (args, next) => {
                const list = args[0]?.Character || [];
                list.forEach(handleCharacter);
                return next(args);
            });
        } catch (e) {
            console.warn('Hook ChatRoomSync 失败:', e);
        }
    }

    waitForSdk();
})();
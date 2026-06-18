// public/js/metaverse-i18n.js
/** @typedef {'ja'|'en'|'zh'} MetaverseLocale */

export const SUPPORTED_METAVERSE_LOCALES = /** @type {const} */ (['ja', 'en', 'zh']);

/**
 * 各キーは ja を基準に en / zh を冗長に保持する（欠落時は ja にフォールバック）
 * @type {Record<string, { ja: string, en: string, zh: string }>}
 */
export const METAVERSE_STRINGS = {
    'info.appTitle': {
        ja: '松山南高校 みんなでメタ',
        en: 'Matsuyama Minami High — Metaverse',
        zh: '松山南高中 大家一起元宇宙',
    },
    'info.worldLabel': { ja: 'ワールド:', en: 'World:', zh: '世界：' },
    'info.positionLabel': { ja: '座標:', en: 'Position:', zh: '坐标：' },
    'info.playerCountLabel': { ja: 'プレイヤー数:', en: 'Players:', zh: '玩家数：' },
    'info.playerListTitle': {
        ja: 'Vキーで視聴開始／Shift+クリックまたはUでマウス解放',
        en: 'V to watch video / Shift+click or U to release mouse',
        zh: '按 V 开始观看 / Shift+单击或 U 解除鼠标锁定',
    },
    'info.pingTitle': { ja: 'サーバー応答時間', en: 'Server latency', zh: '服务器延迟' },

    'admin.playerInfoTitle': { ja: 'プレイヤー情報', en: 'Player info', zh: '玩家信息' },
    'admin.closeTitle': { ja: '閉じる', en: 'Close', zh: '关闭' },
    'admin.username': { ja: 'ユーザー名', en: 'Username', zh: '用户名' },
    'admin.connected': { ja: '接続時間', en: 'Connected', zh: '连接时长' },
    'admin.browser': { ja: 'ブラウザ', en: 'Browser', zh: '浏览器' },
    'admin.os': { ja: 'OS', en: 'OS', zh: '操作系统' },

    'worldLoad.loading': { ja: '読み込み中…', en: 'Loading…', zh: '加载中…' },
    'worldLoad.preparingLabel': {
        ja: 'ワールドを読み込んでいます',
        en: 'Loading world',
        zh: '正在加载世界',
    },
    'worldLoad.preparingAsset': {
        ja: 'マニフェストを読み込んでいます…',
        en: 'Loading manifests…',
        zh: '正在加载清单…',
    },
    'worldLoad.prefab': {
        ja: '大規模データを読み込み中',
        en: 'Loading large assets…',
        zh: '正在加载大型数据…',
    },
    'worldLoad.pdf': {
        ja: 'PDFデータを読み込み中',
        en: 'Loading PDF…',
        zh: '正在加载 PDF…',
    },
    'worldLoad.model': {
        ja: '3Dモデルを読み込み中',
        en: 'Loading 3D model…',
        zh: '正在加载 3D 模型…',
    },
    'worldLoad.finalizing': {
        ja: '表示の準備中…',
        en: 'Preparing display…',
        zh: '正在准备显示…',
    },
    'worldLoad.prefabLine': {
        ja: 'プレハブ「{title}」 — {name}',
        en: 'Prefab "{title}" — {name}',
        zh: '预制体「{title}」 — {name}',
    },
    'worldLoad.prefabTitleOnly': { ja: 'プレハブ「{title}」', en: 'Prefab "{title}"', zh: '预制体「{title}」' },

    'pdf.closeTitle': { ja: '閉じる', en: 'Close', zh: '关闭' },
    'pdf.penThicknessSampleTitle': { ja: '線の太さサンプル', en: 'Stroke width sample', zh: '线条粗细示例' },
    'pdf.penThickness': { ja: '太さ', en: 'Width', zh: '粗细' },
    'pdf.penBtnTitle': { ja: 'ペン', en: 'Pen', zh: '画笔' },
    'pdf.micTitle': { ja: 'PDF通話マイク', en: 'PDF call mic', zh: 'PDF 通话麦克风' },
    'pdf.speakerTitle': { ja: 'PDF通話スピーカー', en: 'PDF call speaker', zh: 'PDF 通话扬声器' },

    'taiko.selectTitle': { ja: '選曲', en: 'Select song', zh: '选曲' },
    'taiko.chartEmpty': { ja: '譜面がありません', en: 'No charts', zh: '暂无谱面' },
    'taiko.close': { ja: '閉じる', en: 'Close', zh: '关闭' },
    'taiko.mpLobbyTitle': { ja: 'マルチプレイ待機中', en: 'Multiplayer lobby', zh: '多人等待中' },
    'taiko.gameHintTitle': { ja: 'ヒント', en: 'Hint', zh: '提示' },
    'taiko.gameTitle': { ja: '轟太鼓', en: 'Taiko', zh: '轰太鼓' },
    'taiko.scoreLabel': { ja: 'スコア', en: 'Score', zh: '分数' },
    'taiko.scoreMax': { ja: 'MAX', en: 'MAX', zh: '最高' },
    'taiko.kaTitle': { ja: 'カッ', en: 'Ka', zh: '咔' },
    'taiko.donTitle': { ja: 'ドン', en: 'Don', zh: '咚' },
    'taiko.resultsLeftBanner': { ja: '成績発表', en: 'Results', zh: '成绩公布' },
    'taiko.resultsSongPlaceholder': { ja: '曲名', en: 'Song', zh: '曲名' },
    'taiko.resultsPlayer': { ja: 'プレイヤー', en: 'Player', zh: '玩家' },
    'taiko.diff.easy': { ja: 'かんたん', en: 'Easy', zh: '简单' },
    'taiko.diff.normal': { ja: 'ふつう', en: 'Normal', zh: '普通' },
    'taiko.diff.hard': { ja: 'むずかしい', en: 'Hard', zh: '困难' },
    'taiko.diff.extreme': { ja: 'おに', en: 'Extreme', zh: '鬼' },
    'taiko.clearLabel': { ja: 'クリア', en: 'Clear', zh: '通关' },
    'taiko.soul': { ja: '魂', en: 'Soul', zh: '魂' },
    'taiko.scoreUnit': { ja: '点', en: 'pts', zh: '分' },
    'taiko.judge.good': { ja: '良', en: 'Good', zh: '良' },
    'taiko.judge.ok': { ja: '可', en: 'OK', zh: '可' },
    'taiko.judge.miss': { ja: '不可', en: 'Miss', zh: '不可' },
    'taiko.maxCombo': { ja: '最大コンボ数', en: 'Max combo', zh: '最大连击' },
    'taiko.rollCount': { ja: '連打数', en: 'Drumroll hits', zh: '连打数' },
    'taiko.rankingTitle': { ja: 'ランキング', en: 'Ranking', zh: '排行榜' },
    'taiko.hintTitle': { ja: '操作方法', en: 'How to play', zh: '操作说明' },
    'taiko.hintPcHtml': {
        ja: '<p><strong>ドン</strong> … F キー（左） / J キー（右）</p><p><strong>カッ</strong> … D キー（左） / K キー（右）</p><p>マウスで太鼓・青い部分をクリックしても入力できます。</p>',
        en: '<p><strong>Don</strong> … F (left) / J (right)</p><p><strong>Ka</strong> … D (left) / K (right)</p><p>You can also click the drum and blue zones.</p>',
        zh: '<p><strong>咚</strong> … F（左）/ J（右）</p><p><strong>咔</strong> … D（左）/ K（右）</p><p>也可点击太鼓与蓝色区域输入。</p>',
    },
    'taiko.hintMobileHtml': {
        ja: '<p><strong>ドン</strong> … 中央の太鼓の画像をタップ</p><p><strong>カッ</strong> … 青い部分（太鼓の左右）をタップ</p>',
        en: '<p><strong>Don</strong> … tap the center drum</p><p><strong>Ka</strong> … tap the blue sides</p>',
        zh: '<p><strong>咚</strong> … 点击中央太鼓图</p><p><strong>咔</strong> … 点击鼓两侧蓝色区域</p>',
    },

    'chat.header': { ja: 'チャット', en: 'Chat', zh: '聊天' },
    'chat.placeholder': {
        ja: 'メッセージを入力... @でメンション',
        en: 'Type a message… @ to mention',
        zh: '输入消息… @ 提及',
    },

    'menu.mobileToggleAria': { ja: 'メニュー', en: 'Menu', zh: '菜单' },
    'menu.adminTitle': { ja: 'あどみんメニュー', en: 'Admin menu', zh: '管理菜单' },
    'menu.micMuteTitle': { ja: 'マイクミュート', en: 'Mic mute', zh: '麦克风静音' },
    'menu.speakerMuteTitle': { ja: 'スピーカーミュート', en: 'Speaker mute', zh: '扬声器静音' },
    'menu.stampTitle': { ja: 'スタンプ', en: 'Stamps', zh: '表情印章' },
    'menu.videoTitle': { ja: 'ビデオ通話', en: 'Video call', zh: '视频通话' },
    'menu.helpTitle': { ja: '操作方法', en: 'Controls', zh: '操作说明' },
    'menu.helpAria': { ja: '操作方法', en: 'Controls', zh: '操作说明' },
    'menu.restartTitle': {
        ja: 'リスタート（初期地点へ）',
        en: 'Restart (spawn)',
        zh: '重新开始（回到出生点）',
    },
    'menu.restartAria': {
        ja: '現在のワールドの初期地点へ戻る',
        en: 'Return to spawn in this world',
        zh: '返回当前世界的出生点',
    },
    'menu.settingsTitle': { ja: '設定', en: 'Settings', zh: '设置' },
    'menu.logoutTitle': { ja: '退出', en: 'Exit', zh: '退出' },

    'adminMenu.title': { ja: 'あどみんメニュー', en: 'Admin menu', zh: '管理菜单' },
    'adminMenu.invisible': { ja: '透明化（ネームタグごと）', en: 'Invisible (incl. name tag)', zh: '隐身（含名牌）' },
    'adminMenu.fly': { ja: '飛行モード（落下なし）', en: 'Fly mode (no fall)', zh: '飞行模式（无下落）' },
    'adminMenu.speed': { ja: '高速移動', en: 'Fast move', zh: '快速移动' },
    'adminMenu.openAdmin': { ja: '管理画面（admin）を開く', en: 'Open admin panel', zh: '打开管理后台（admin）' },

    'help.title': { ja: '操作方法', en: 'Controls', zh: '操作说明' },
    'help.closeAria': { ja: '閉じる', en: 'Close', zh: '关闭' },
    'help.pcBasicTitle': { ja: '基本操作（PC）', en: 'Basics (PC)', zh: '基本操作（PC）' },
    'help.pcBasic1': {
        ja: '画面（3D）をクリックしてマウスポインターをロックし、マウス移動で視点を変えます。',
        en: 'Click the 3D view to lock the pointer and move the mouse to look around.',
        zh: '点击 3D 画面锁定鼠标指针，移动鼠标调整视角。',
    },
    'help.pcBasic2Html': {
        ja: '<kbd>U</kbd> キー、または <kbd>Shift</kbd>＋クリック／<kbd>Ctrl</kbd>＋クリックでポインターロックを解除します。',
        en: 'Press <kbd>U</kbd>, or <kbd>Shift</kbd>+click / <kbd>Ctrl</kbd>+click to unlock the pointer.',
        zh: '按 <kbd>U</kbd>，或 <kbd>Shift</kbd>+单击 / <kbd>Ctrl</kbd>+单击解除指针锁定。',
    },
    'help.pcBasic3Html': {
        ja: '<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> で移動、<kbd>Space</kbd> でジャンプします。',
        en: '<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> to move, <kbd>Space</kbd> to jump.',
        zh: '用 <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 移动，<kbd>Space</kbd> 跳跃。',
    },
    'help.pcBasic4Html': {
        ja: '<kbd>Shift</kbd> を押しながら移動するとダッシュします。',
        en: 'Hold <kbd>Shift</kbd> while moving to sprint.',
        zh: '按住 <kbd>Shift</kbd> 移动可冲刺。',
    },
    'help.eKeyTitle': { ja: '近くのオブジェクト（E キー）', en: 'Nearby objects (E)', zh: '附近物体（E 键）' },
    'help.eKeyP': {
        ja: 'プロンプトが表示されているときに E を押すと、次の優先順で動作します（ワールドにより異なります）。',
        en: 'When a prompt is shown, E triggers actions in this priority (varies by world):',
        zh: '出现提示时按 E，将按以下优先级执行（因世界而异）：',
    },
    'help.eKey1': { ja: '太鼓ゲームのゾーン', en: 'Taiko zone', zh: '太鼓区域' },
    'help.eKey2': { ja: 'PDF ビューアの開始', en: 'Open PDF viewer', zh: '打开 PDF 查看器' },
    'help.eKey3': { ja: 'テレポート', en: 'Teleport', zh: '传送' },
    'help.mediaTitle': { ja: 'ビデオ・音声・チャット', en: 'Video, voice, chat', zh: '视频、语音与聊天' },
    'help.media1': {
        ja: '下のメニューからマイク・スピーカー・ビデオ通話・スタンプを操作できます。',
        en: 'Use the bottom bar for mic, speaker, video, and stamps.',
        zh: '使用底部菜单控制麦克风、扬声器、视频与印章。',
    },
    'help.media2': {
        ja: '誰かがビデオ配信中のとき、V キーでその配信を視聴できます（入力欄にフォーカスがあるときは無効）。',
        en: 'When someone is streaming video, press V to watch (disabled while typing in a field).',
        zh: '有人开启视频时按 V 观看（输入框聚焦时无效）。',
    },
    'help.media3': {
        ja: 'プレイヤー一覧のユーザーを Shift＋クリックするか U でマウスを解放してからクリックすると、個別に視聴できます。',
        en: 'Shift+click a user in the list, or press U to unlock the mouse, then click to watch them.',
        zh: '在玩家列表 Shift+单击用户，或按 U 解除鼠标后再单击即可单独观看。',
    },
    'help.media4': {
        ja: 'チャットは画面のチャット欄から送信できます（@ でメンション）。',
        en: 'Send chat from the chat panel (@ to mention).',
        zh: '在聊天栏发送消息（@ 提及）。',
    },
    'help.pdfTitle': { ja: 'PDF ビューア', en: 'PDF viewer', zh: 'PDF 查看器' },
    'help.pdf1': {
        ja: 'Esc で閉じます。パン・ズーム・ペン描画はオーバーレイ内の UI に従ってください。',
        en: 'Esc closes it. Pan, zoom, and pen follow the overlay UI.',
        zh: 'Esc 关闭。平移、缩放与画笔请按叠加层内 UI 操作。',
    },
    'help.settingsTitle': { ja: '設定・退出', en: 'Settings & exit', zh: '设置与退出' },
    'help.settings1': {
        ja: '歯車アイコンから一人称／三人称視点や描画・音声設定を変更できます。',
        en: 'Use the gear icon for first/third person and graphics/audio settings.',
        zh: '齿轮图标可切换第一/第三人称及画面与音频设置。',
    },
    'help.settings2': {
        ja: '更新アイコンから、いまいるワールドの初期地点（スポーン）へ戻れます。',
        en: 'Use the refresh icon to return to this world’s spawn.',
        zh: '刷新图标可回到当前世界的出生点。',
    },
    'help.settings3': {
        ja: '退出ボタンからロビーへ戻るかログアウトを選べます。',
        en: 'Exit lets you return to the lobby or log out.',
        zh: '退出可选择返回大厅或注销。',
    },
    'help.mobileTitle': { ja: 'スマートフォン・タブレット', en: 'Phone & tablet', zh: '手机与平板' },
    'help.mobile1Html': {
        ja: '左下のジョイスティックで移動、画面右側のドラッグで視点操作、<span class="help-inline-btn">ジャンプ</span> ボタンでジャンプします。',
        en: 'Use the joystick to move, drag the right side to look, and the <span class="help-inline-btn">Jump</span> button to jump.',
        zh: '左下摇杆移动，右侧拖动调整视角，按 <span class="help-inline-btn">跳跃</span> 按钮跳跃。',
    },
    'help.mobile2': {
        ja: '画面右上のメニュー（ハンバーガー）から下段のメニューバーにアクセスできます。',
        en: 'Open the top-right menu (hamburger) to reach the bottom menu bar.',
        zh: '点右上角菜单（汉堡）可打开底部菜单栏。',
    },
    'help.adminTitle': { ja: '管理者向け', en: 'For admins', zh: '管理员' },
    'help.admin1Html': {
        ja: '管理者のみ、シールドアイコンから透明化・飛行モード・高速移動などを切り替えられます。飛行中は <kbd>Space</kbd>（上昇）と <kbd>C</kbd>（下降）が使えます。',
        en: 'Admins can use the shield icon for invisibility, fly mode, and fast move. While flying, <kbd>Space</kbd> ascends and <kbd>C</kbd> descends.',
        zh: '管理员可用盾牌图标切换隐身、飞行与快速移动。飞行时 <kbd>Space</kbd> 上升、<kbd>C</kbd> 下降。',
    },

    'logout.title': { ja: '退出', en: 'Exit', zh: '退出' },
    'logout.body': {
        ja: 'ロビーに戻るか、ログアウトするか選んでください。',
        en: 'Return to the lobby or log out.',
        zh: '返回大厅或注销登录。',
    },
    'logout.lobby': { ja: 'ロビーに戻る', en: 'Back to lobby', zh: '返回大厅' },
    'logout.confirm': { ja: 'ログアウト', en: 'Log out', zh: '注销' },

    'restart.title': { ja: 'リスタート', en: 'Restart', zh: '重新开始' },
    'restart.bodyHtml': {
        ja: 'このワールドの<strong>初期地点（スポーン）</strong>に移動します。飛行機を操縦中の場合は降りてから移動します。',
        en: 'You will move to this world’s <strong>spawn point</strong>. If you are piloting an aircraft, exit it first.',
        zh: '将移动到本世界的<strong>出生点</strong>。若正在驾驶飞机请先下机。',
    },
    'restart.confirm': { ja: '初期地点へ移動', en: 'Go to spawn', zh: '前往出生点' },
    'restart.cancel': { ja: 'キャンセル', en: 'Cancel', zh: '取消' },

    'settings.title': { ja: '設定', en: 'Settings', zh: '设置' },
    'settings.close': { ja: '×', en: '×', zh: '×' },
    'settings.cat.general': { ja: '一般', en: 'General', zh: '常规' },
    'settings.cat.audio': { ja: '音声', en: 'Audio', zh: '音频' },
    'settings.cat.draw': { ja: '描画', en: 'Graphics', zh: '画面' },
    'settings.generalHeading': { ja: '一般', en: 'General', zh: '常规' },
    'settings.languageLabel': { ja: '言語:', en: 'Language:', zh: '语言：' },
    'settings.langJa': { ja: '日本語', en: '日本語', zh: '日语' },
    'settings.langEn': { ja: 'English', en: 'English', zh: '英语' },
    'settings.langZh': { ja: '中文（简体）', en: 'Chinese (Simplified)', zh: '中文（简体）' },
    'settings.languageHint': {
        ja: '表示言語を選択してください',
        en: 'Choose the display language',
        zh: '请选择界面语言',
    },
    'settings.audioHeading': { ja: '音声', en: 'Audio', zh: '音频' },
    'settings.micTestLabel': { ja: 'マイクテスト', en: 'Mic test', zh: '麦克风测试' },
    'settings.micTestDesc': {
        ja: 'マイクに問題がありますか? テストを開始し、何でもいいので話してください。声を再生してお返しします。',
        en: 'Mic issues? Start the test and speak; your voice will be played back.',
        zh: '麦克风有问题吗？开始测试并说话，系统会回放你的声音。',
    },
    'settings.micTestStart': { ja: 'テストを開始', en: 'Start test', zh: '开始测试' },
    'settings.micTestStop': { ja: 'テストを中止', en: 'Stop test', zh: '停止测试' },
    'settings.micDeviceLabel': { ja: '使用するマイク:', en: 'Microphone:', zh: '麦克风：' },
    'settings.speakerDeviceLabel': { ja: '使用するスピーカー:', en: 'Speaker:', zh: '扬声器：' },
    'settings.defaultDevice': { ja: 'デフォルト', en: 'Default', zh: '默认' },
    'settings.micDeviceHint': {
        ja: '使用するマイクデバイスを選択してください',
        en: 'Select the microphone device',
        zh: '请选择麦克风设备',
    },
    'settings.speakerDeviceHint': {
        ja: '使用するスピーカーデバイスを選択してください',
        en: 'Select the speaker device',
        zh: '请选择扬声器设备',
    },
    'settings.micVolumeLabel': { ja: 'マイク入力倍率:', en: 'Mic gain:', zh: '麦克风增益：' },
    'settings.micVolumeHint': {
        ja: 'マイクの入力音量倍率（0%で無音、100%で等倍、最大300%）',
        en: 'Mic input gain (0% mute, 100% unity, up to 300%)',
        zh: '麦克风输入增益（0% 静音，100% 原音量，最高 300%）',
    },
    'settings.speakerVolumeLabel': { ja: 'スピーカー音量:', en: 'Speaker volume:', zh: '扬声器音量：' },
    'settings.speakerVolumeHint': {
        ja: 'スピーカーの出力音量を調整します',
        en: 'Adjust speaker output level',
        zh: '调节扬声器输出音量',
    },
    'settings.drawHeading': { ja: '描画', en: 'Graphics', zh: '画面' },
    'settings.viewDistanceLabel': { ja: '描画距離:', en: 'Render distance:', zh: '渲染距离：' },
    'settings.viewDistanceUnit': { ja: 'm', en: 'm', zh: '米' },
    'settings.viewDistanceHint': {
        ja: '足元を中心とした球。範囲外のワールド・PDF・他プレイヤーは非表示（スカイドームは常に表示）',
        en: 'Sphere around your feet; world/PDF/others outside range are hidden (sky always shown).',
        zh: '以脚下为球心；范围外的世界、PDF 与其他玩家隐藏（天空始终显示）。',
    },
    'settings.showViewRangeLabel': { ja: '描画範囲の表示', en: 'Show render range', zh: '显示渲染范围' },
    'settings.showViewRangeTitle': {
        ja: '足元中心・描画距離の球（青）と2倍半径（黄）を半透明表示',
        en: 'Semi-transparent sphere (blue) and 2× radius (yellow) at your feet',
        zh: '在脚下半透明显示渲染球（蓝）与两倍半径（黄）',
    },
    'settings.showViewRangeHint': {
        ja: 'デバッグ用。青系＝描画距離 R、黄系＝半径 2R',
        en: 'Debug: blue = distance R, yellow = radius 2R',
        zh: '调试：蓝为距离 R，黄为半径 2R',
    },
    'settings.developerModeLabel': { ja: '開発者モード', en: 'Developer mode', zh: '开发者模式' },
    'settings.developerModeTitle': {
        ja: 'ワールド読み込み時にファイル名などの詳細を表示',
        en: 'Show detailed file names during world load',
        zh: '世界加载时显示详细文件名',
    },
    'settings.developerModeHint': {
        ja: 'ON にするとロード画面にプレハブ名・ファイル名などが表示されます',
        en: 'When on, the load screen shows prefab names and file paths.',
        zh: '开启后，加载画面会显示预制体名与文件路径。',
    },
    'settings.proModeLabel': { ja: 'プロモード', en: 'Pro mode', zh: '专业模式' },
    'settings.proModeTitle': {
        ja: 'UIを最小化して3D画面を広く表示します',
        en: 'Minimize UI for a wider 3D view',
        zh: '最小化界面以扩大 3D 视野',
    },
    'settings.proModeHint': {
        ja: 'ON にするとモバイルはメニューボタンのみ表示（操作系は非表示のまま操作可能）、PC は左上の設定アイコン（40% 透明度）のみが表示されます',
        en: 'When on, mobile shows only the menu button (controls stay invisible but usable); PC shows only a settings icon (40% opacity) at top left.',
        zh: '开启后，手机仅显示菜单按钮（操作区不可见但仍可操作），电脑仅在左上角显示设置图标（40% 透明度）。',
    },
    'settings.viewModeLabel': { ja: '画面表示', en: 'View', zh: '视角' },
    'settings.viewModeToggleTitle': {
        ja: '1人称と3人称を切り替える',
        en: 'Toggle first / third person',
        zh: '切换第一/第三人称',
    },
    'settings.viewModeHint': {
        ja: '1人称はアバターの頭部視点になります',
        en: 'First person uses the avatar head view',
        zh: '第一人称使用角色头部视角',
    },
    'settings.viewFirst': { ja: '1人称視点', en: 'First person', zh: '第一人称' },
    'settings.viewThird': { ja: '3人称視点', en: 'Third person', zh: '第三人称' },
    'settings.visualModeLabel': { ja: 'ハイコントラスト', en: 'High contrast', zh: '高对比度' },
    'settings.visualModeTitle': {
        ja: '白ベースのまま UI・シーンのコントラストを強めます',
        en: 'Boost UI and scene contrast while keeping a light base',
        zh: '保持浅色底的同时增强界面与场景对比度',
    },
    'settings.visualModeHint': {
        ja: 'オブジェクトの明暗差を強め、UI を白ベースの高コントラスト表示にします。露出はハイコントラスト時に少し上がります',
        en: 'Boosts object contrast and UI on a white base. Exposure is slightly higher in high contrast mode',
        zh: '增强物体明暗对比，界面保持浅色高对比。高对比度模式下曝光会略提高',
    },
    'settings.graphicsTierLabel': { ja: '描画品質:', en: 'Quality:', zh: '画质：' },
    'settings.graphicsTierHigh': { ja: '高（シャドウ・AA 重視）', en: 'High (shadows & AA)', zh: '高（阴影与抗锯齿）' },
    'settings.graphicsTierMedium': { ja: '中', en: 'Medium', zh: '中' },
    'settings.graphicsTierLow': { ja: '低（軽量）', en: 'Low (lightweight)', zh: '低（轻量）' },
    'settings.graphicsTierHint': {
        ja: 'WebXR 中は自動で軽量設定になります',
        en: 'WebXR forces lightweight settings',
        zh: 'WebXR 下会自动使用轻量设置',
    },
    'settings.exposureLabel': { ja: '露出:', en: 'Exposure:', zh: '曝光：' },
    'settings.exposureHint': {
        ja: 'ACES Filmic の露出。HDR と直接光のバランス調整に使います',
        en: 'ACES Filmic exposure for HDR / direct-light balance',
        zh: 'ACES Filmic 曝光，用于 HDR 与直射光平衡',
    },
    'settings.pixelRatioLabel': { ja: 'ピクセル比:', en: 'Pixel ratio:', zh: '像素比：' },
    'settings.pixelRatioDevice': { ja: 'デバイスどおり', en: 'Device native', zh: '跟随设备' },
    'settings.pixelRatioHint': {
        ja: '低いほど軽くなります（WebXR 中は最大 1 に制限）',
        en: 'Lower is faster (capped at 1 in WebXR)',
        zh: '越低越省性能（WebXR 下最高为 1）',
    },

    'video.title': { ja: '配信設定', en: 'Broadcast', zh: '直播设置' },
    'video.previewLabel': { ja: 'プレビュー', en: 'Preview', zh: '预览' },
    'video.cameraTab': { ja: 'カメラ', en: 'Camera', zh: '摄像头' },
    'video.screenTab': { ja: '画面共有', en: 'Screen share', zh: '屏幕共享' },
    'video.cameraDevice': { ja: 'カメラ', en: 'Camera', zh: '摄像头' },
    'video.resolution': { ja: '解像度', en: 'Resolution', zh: '分辨率' },
    'video.includeAudio': { ja: '音声を含める', en: 'Include audio', zh: '包含音频' },
    'video.start': { ja: '開始', en: 'Start', zh: '开始' },
    'video.stop': { ja: '停止', en: 'Stop', zh: '停止' },

    'mobile.interact': { ja: 'インタラクト', en: 'Interact', zh: '交互' },
    'mobile.jumpAria': { ja: 'ジャンプ', en: 'Jump', zh: '跳跃' },
    'mobile.jumpLabel': { ja: 'ジャンプ', en: 'Jump', zh: '跳跃' },
    'mobile.aircraftAccel': { ja: '加速', en: 'Accel', zh: '加速' },
    'mobile.aircraftDecel': { ja: '減速', en: 'Decel', zh: '减速' },
    'mobile.aircraftBrake': { ja: 'ブレーキ', en: 'Brake', zh: '刹车' },
    'mobile.aircraftBoard': { ja: '搭乗', en: 'Board', zh: '登机' },
    'mobile.landscape': { ja: '横に回転してください', en: 'Please rotate to landscape', zh: '请横屏使用' },

    'ui.teleportPrefix': { ja: 'テレポート - ', en: 'Teleport - ', zh: '传送 - ' },
    'ui.taikoPrompt': { ja: '[E] 太鼓をたたく', en: '[E] Play taiko', zh: '[E] 打太鼓' },
    'ui.pdfPrompt': { ja: 'PDFを表示', en: 'Show PDF', zh: '显示 PDF' },
    'ui.glbAnimDefault': { ja: '[E] アニメーション', en: '[E] Animation', zh: '[E] 动画' },
    'ui.mobileAnimDefault': { ja: 'アニメーションを再生', en: 'Play animation', zh: '播放动画' },
    'ui.pingNone': { ja: '応答なし', en: 'No response', zh: '无响应' },
    'ui.pingConnecting': { ja: '接続中…', en: 'Connecting…', zh: '连接中…' },
    'ui.pingReconnecting': { ja: '再接続中…', en: 'Reconnecting…', zh: '重新连接中…' },
    'ui.pingTitle': { ja: '応答時間', en: 'Latency', zh: '延迟' },
    'ui.videoOnTitle': { ja: 'ビデオON', en: 'Video on', zh: '视频开' },
    'ui.micOnTitle': { ja: 'マイクON', en: 'Mic on', zh: '麦克风开' },
    'ui.micOffTitle': { ja: 'マイクOFF', en: 'Mic off', zh: '麦克风关' },
    'ui.spkOnTitle': { ja: 'スピーカーON', en: 'Speaker on', zh: '扬声器开' },
    'ui.spkOffTitle': { ja: 'スピーカーOFF', en: 'Speaker off', zh: '扬声器关' },
    'ui.watchVideoTitle': { ja: 'ビデオを視聴', en: 'Watch video', zh: '观看视频' },
    'ui.watchVideoBtn': { ja: '視聴', en: 'Watch', zh: '观看' },
    'ui.blockedBadgeTitle': { ja: 'ブロック済み（クリックで解除）', en: 'Blocked (click to unblock)', zh: '已屏蔽（点击解除）' },
    'ui.blockedHeading': { ja: 'ブロック済み', en: 'Blocked', zh: '已屏蔽' },
    'ui.perfTitle': { ja: '性能ティア / 直近FPSサンプル', en: 'Perf tier / recent FPS', zh: '性能档位 / 最近 FPS' },
    'ui.roleTitle': { ja: '種別', en: 'Role', zh: '身份' },
    'ui.roleStudent': { ja: '[生徒]', en: '[Student]', zh: '[学生]' },
    'ui.roleTeacher': { ja: '[教師]', en: '[Teacher]', zh: '[教师]' },
    'ui.roleAdmin': { ja: '[管理者]', en: '[Admin]', zh: '[管理员]' },
    'ui.playerMenuTitle': { ja: 'プレイヤーメニュー', en: 'Player menu', zh: '玩家菜单' },
    'ui.aircraftPilot': { ja: '操縦する', en: 'Pilot', zh: '驾驶' },
    'ui.aircraftPassenger': { ja: '同乗する', en: 'Ride along', zh: '同乘' },
    'ui.aircraftBoardSuffix': { ja: '（クリック / E）', en: '(click / E)', zh: '（点击 / E）' },
    'ui.aircraftBoardHint': { ja: 'クリックでも搭乗できます', en: 'Or tap to board', zh: '也可点击进入' },
    'ui.aircraftEasyHudPos': { ja: '位置', en: 'Pos', zh: '位置' },
    'ui.aircraftEasyHudOmega': { ja: '角速度', en: 'Angular vel.', zh: '角速度' },
    'ui.aircraftEasyHudAtt': { ja: '向き', en: 'Attitude', zh: '姿态' },
    'ui.aircraftEasyHudSpeed': { ja: '速度', en: 'Speed', zh: '速度' },
    'ui.aircraftEasyHudView': { ja: '視点', en: 'View', zh: '视角' },
    'ui.aircraftKnots': { ja: 'ノット', en: 'kt', zh: '节' },
    'ui.aircraftOmegaPitch': { ja: 'ピッチ', en: 'Pitch', zh: '俯仰' },
    'ui.aircraftOmegaRoll': { ja: 'ロール', en: 'Roll', zh: '横滚' },
    'ui.aircraftOmegaYaw': { ja: 'ヨー', en: 'Yaw', zh: '偏航' },
    'ui.aircraftExit': { ja: '降りる (F)', en: 'Exit (F)', zh: '下车 (F)' },
    'ui.aircraftCamera': { ja: '視点 (V)', en: 'View (V)', zh: '视角 (V)' },
    'ui.aircraftExitShort': { ja: 'F 降りる', en: 'F Exit', zh: 'F 下车' },
    'ui.aircraftCameraShort': { ja: 'V 視点', en: 'V View', zh: 'V 视角' },
    'ui.aircraftVfeWarnShort': { ja: 'Vfe', en: 'Vfe', zh: 'Vfe' },
    'ui.aircraftGrounded': { ja: '接地', en: 'Ground', zh: '接地' },
    'ui.aircraftAirborne': { ja: '空中', en: 'Air', zh: '空中' },

    'playerAction.report': { ja: '通報', en: 'Report', zh: '举报' },
    'playerAction.block': { ja: 'ブロック', en: 'Block', zh: '屏蔽' },

    'chat.systemInit': { ja: 'チャットシステムが初期化されました', en: 'Chat is ready', zh: '聊天系统已就绪' },
    'chat.joined': { ja: '{name} が参加しました', en: '{name} joined', zh: '{name} 加入了' },
    'chat.left': { ja: '{name} が退出しました', en: '{name} left', zh: '{name} 离开了' },
    'chat.sending': { ja: '送信しています…', en: 'Sending…', zh: '发送中…' },
    'chat.waitSend': { ja: '送信しています。少しお待ちください', en: 'Please wait, sending…', zh: '正在发送，请稍候' },
    'chat.sendFailedBubble': { ja: '送信されませんでした', en: 'Not sent', zh: '未发送' },
    'chat.sendFailed': { ja: '送信できませんでした', en: 'Could not send', zh: '发送失败' },
    'chat.moderationWarn': { ja: '不適切な内容である可能性があります', en: 'May contain inappropriate content', zh: '可能含有不当内容' },
    'chat.showContentAria': { ja: 'チャット内容を表示または隠す', en: 'Show or hide message', zh: '显示或隐藏聊天内容' },
    'chat.showContentTitle': { ja: '内容を表示', en: 'Show', zh: '显示内容' },
    'chat.hideContentTitle': { ja: '内容を隠す', en: 'Hide', zh: '隐藏内容' },

    'net.adminNameForbidden': { ja: '「admin」は管理者専用です。', en: '"admin" is reserved for administrators.', zh: '「admin」仅供管理员使用。' },
    'net.teleporterDenied': { ja: 'このテレポーターは利用できません。', en: 'This teleporter is unavailable.', zh: '无法使用该传送门。' },
    'net.kicked': { ja: '管理者によってキックされました。', en: 'You were kicked by an administrator.', zh: '你已被管理员踢出。' },
    'net.notConnected': { ja: '接続されていません', en: 'Not connected', zh: '未连接' },

    'main.needBasicAuth': {
        ja: '認証が必要です。Basic認証でログインしてください。',
        en: 'Authentication required. Please log in with Basic auth.',
        zh: '需要认证，请使用 Basic 认证登录。',
    },
    'main.adminAuthFailed': {
        ja: '管理者認証に失敗しました。',
        en: 'Administrator authentication failed.',
        zh: '管理员认证失败。',
    },
    'main.teleporterError': { ja: 'このテレポーターは利用できません', en: 'This teleporter is unavailable', zh: '无法使用该传送门' },

    'menu.micDeviceChanged': {
        ja: 'マイクデバイスを変更しました。マイクを一度OFFにしてから再度ONにしてください。',
        en: 'Mic device changed. Turn the mic OFF, then ON again.',
        zh: '已更换麦克风。请先关闭麦克风再重新打开。',
    },
    'menu.micPlaybackServer': { ja: '声を再生中です（サーバー経由）', en: 'Playing back (via server)', zh: '正在回放（经服务器）' },
    'menu.micPlaybackLocal': { ja: '声を再生中です', en: 'Playing back', zh: '正在回放' },
    'menu.micDenied': { ja: 'マイクにアクセスできません', en: 'Cannot access microphone', zh: '无法访问麦克风' },
    'menu.videoNoCamera': { ja: 'カメラにアクセスできません', en: 'Cannot access camera', zh: '无法访问摄像头' },
    'menu.videoLive': { ja: '配信中', en: 'Live', zh: '直播中' },
    'menu.screenShareEnded': { ja: '画面共有が終了しました', en: 'Screen share ended', zh: '屏幕共享已结束' },
    'menu.screenShareCancelled': { ja: '画面共有がキャンセルされました', en: 'Screen share cancelled', zh: '已取消屏幕共享' },
    'menu.screenCaptureFailed': { ja: '画面の取得に失敗しました', en: 'Failed to capture screen', zh: '获取屏幕失败' },
    'menu.videoStartFailed': { ja: 'ビデオの開始に失敗しました', en: 'Failed to start video', zh: '无法开始视频' },
    'menu.cameraFallbackNumbered': { ja: 'カメラ {n}', en: 'Camera {n}', zh: '摄像头 {n}' },
    'menu.micFallbackNumbered': { ja: 'マイク {n}', en: 'Mic {n}', zh: '麦克风 {n}' },
    'menu.speakerFallbackNumbered': { ja: 'スピーカー {n}', en: 'Speaker {n}', zh: '扬声器 {n}' },
    'menu.micFallback': { ja: 'マイク', en: 'Mic', zh: '麦克风' },
    'menu.speakerFallback': { ja: 'スピーカー', en: 'Speaker', zh: '扬声器' },

    'taiko.playDemo': { ja: 'デモで遊ぶ', en: 'Play demo', zh: '试玩演示' },
    'taiko.chartFetchFailed': { ja: '譜面の取得に失敗しました', en: 'Failed to load chart', zh: '获取谱面失败' },
    'taiko.mpGroupHint': {
        ja: 'グループ「{group}」・{count}人でプレイ。パートを選んでください。',
        en: 'Group "{group}", {count} players. Choose a part.',
        zh: '分组「{group}」，{count} 人游玩。请选择声部。',
    },
    'taiko.mpNotConnected': {
        ja: '接続されていません。ページを再読み込みしてください。',
        en: 'Not connected. Reload the page.',
        zh: '未连接。请刷新页面。',
    },
    'taiko.mpNotJoined': { ja: '未参加', en: 'Not joined', zh: '未加入' },
    'taiko.mpRoomFailed': { ja: 'ルームに入れませんでした。', en: 'Could not join room.', zh: '无法进入房间。' },
    'taiko.mpPartSelected': { ja: '{label} を選択しました', en: 'Selected {label}', zh: '已选择 {label}' },
    'taiko.mpBgmLoading': { ja: 'BGM読込中', en: 'Loading BGM', zh: 'BGM 加载中' },
    'taiko.mpReadyOk': { ja: 'OK', en: 'OK', zh: 'OK' },
    'taiko.mpBgmFailed': { ja: 'BGMの準備に失敗: ', en: 'BGM prep failed: ', zh: 'BGM 准备失败：' },
    'taiko.mpPartFull': { ja: 'このパートは埋まっています', en: 'This part is full', zh: '该声部已满' },
    'taiko.mpCannotChangePlaying': { ja: '演奏中はパートを変更できません', en: 'Cannot change part while playing', zh: '演奏中无法更换声部' },
    'taiko.mpSelectFailed': { ja: '選択できませんでした', en: 'Could not select', zh: '无法选择' },
    'taiko.mpFullStarting': { ja: '満員になりました。まもなく開始します…', en: 'Full. Starting soon…', zh: '已满员，即将开始…' },
    'taiko.mpCountdown': { ja: '開始まで {sec} 秒', en: 'Starting in {sec}s', zh: '距开始 {sec} 秒' },
    'taiko.alertNoChartPart': {
        ja: 'パート{part}の譜面がありません。管理画面の譜面で{hint}を設定してください。',
        en: 'No chart for part {part}. Set {hint} in the admin chart editor.',
        zh: '声部 {part} 无谱面。请在管理后台谱面中设置 {hint}。',
    },
    'taiko.part1p': { ja: '1P', en: '1P', zh: '1P' },
    'taiko.part2p': { ja: '2P', en: '2P', zh: '2P' },
    'taiko.part3p': { ja: '3P', en: '3P', zh: '3P' },
    'taiko.alertChartFailed': { ja: '譜面の取得に失敗しました', en: 'Failed to fetch chart', zh: '获取谱面失败' },
    'taiko.totalScoreTitle': { ja: '総合得点', en: 'Total score', zh: '总分' },
    'taiko.totalPoints': { ja: '合計 {total}点', en: 'Total {total} pts', zh: '合计 {total} 分' },
    'taiko.multiplayer': { ja: 'マルチプレイ', en: 'Multiplayer', zh: '多人' },
    'taiko.mpResultLine': { ja: '{name} {score}点', en: '{name} {score} pts', zh: '{name} {score} 分' },
    'taiko.rankingLine': { ja: '{rank} {name} {score}点', en: '{rank} {name} {score} pts', zh: '{rank} {name} {score} 分' },
    'taiko.rankingPlaceholder': { ja: '{rank} — —', en: '{rank} — —', zh: '{rank} — —' },
    'taiko.judgeRoll': { ja: '連打', en: 'Drumroll', zh: '连打' },
    'taiko.waitingOthers': {
        ja: '演奏終了。ほかのプレイヤーの終了を待っています…',
        en: 'Performance ended. Waiting for other players…',
        zh: '演奏结束，等待其他玩家…',
    },
    'taiko.demoChartName': { ja: 'デモ', en: 'Demo', zh: '演示' },

    'flightBoard.opsStatus': { ja: '運行状況', en: 'Operations', zh: '运行状况' },
    'flightBoard.filterDomestic': { ja: '国内線', en: 'Domestic', zh: '国内线' },
    'flightBoard.filterInternational': { ja: '国際線', en: 'International', zh: '国际线' },
    'flightBoard.layoutAlert': { ja: 'LAYOUT ALERT', en: 'LAYOUT ALERT', zh: 'LAYOUT ALERT' },
    'flightBoard.loading': { ja: 'データ取得中…', en: 'Loading flight data…', zh: '正在获取数据…' },
    'flightBoard.fetchFailed': { ja: '取得失敗', en: 'Fetch failed', zh: '获取失败' },
    'flightBoard.depSection': { ja: '出発 DEP', en: 'DEPARTURES', zh: '出发 DEP' },
    'flightBoard.arrSection': { ja: '到着 ARR', en: 'ARRIVALS', zh: '到达 ARR' },
    'flightBoard.colTime': { ja: '時刻', en: 'Time', zh: '时刻' },
    'flightBoard.colFlight': { ja: '便名', en: 'Flight', zh: '航班' },
    'flightBoard.colAirline': { ja: '会社', en: 'Airline', zh: '航空公司' },
    'flightBoard.colDestination': { ja: '行き先', en: 'Destination', zh: '目的地' },
    'flightBoard.colOrigin': { ja: '出発', en: 'Origin', zh: '出发地' },
    'flightBoard.colStatus': { ja: '状況', en: 'Status', zh: '状态' },
    'flightBoard.changed': { ja: 'changed', en: 'changed', zh: 'changed' },
    'flightBoard.noData': { ja: '--- NO DATA ---', en: '--- NO DATA ---', zh: '--- NO DATA ---' },
    'flightBoard.srcAirport': { ja: 'SRC 松山空港', en: 'SRC Matsuyama Airport', zh: 'SRC 松山机场' },
    'flightBoard.srcBackup': {
        ja: 'SRC ODPT/JETSTAR (backup)',
        en: 'SRC ODPT/JETSTAR (backup)',
        zh: 'SRC ODPT/JETSTAR (backup)',
    },
    'flightBoard.editorAll': { ja: '発着（全便）', en: 'Flights (all)', zh: '航班（全部）' },
    'flightBoard.editorDomestic': { ja: '発着（国内線）', en: 'Flights (domestic)', zh: '航班（国内线）' },
    'flightBoard.editorInternational': {
        ja: '発着（国際線）',
        en: 'Flights (international)',
        zh: '航班（国际线）',
    },
    'flightBoard.previewDefault': {
        ja: '松山空港 運行状況（保存後に表示）',
        en: 'Matsuyama Airport — operations (shown after save)',
        zh: '松山机场 运行状况（保存后显示）',
    },
    'flightBoard.previewWithTag': {
        ja: '松山空港 {tag}（保存後に表示）',
        en: 'Matsuyama Airport {tag} (shown after save)',
        zh: '松山机场 {tag}（保存后显示）',
    },
    'flightBoard.previewOps': {
        ja: '松山空港 運行状況',
        en: 'Matsuyama Airport — operations',
        zh: '松山机场 运行状况',
    },
    'flightBoard.previewTagOnly': {
        ja: '松山空港 {tag}',
        en: 'Matsuyama Airport {tag}',
        zh: '松山机场 {tag}',
    },
};

/** @type {MetaverseLocale} */
let currentLocale = 'ja';

/**
 * ブラウザの言語・地域タグから ja / en / zh を推定する
 * @returns {MetaverseLocale}
 */
export function detectBrowserMetaverseLocale() {
    const candidates = [];
    if (typeof navigator !== 'undefined') {
        if (Array.isArray(navigator.languages)) {
            candidates.push(...navigator.languages);
        }
        if (navigator.language) {
            candidates.push(navigator.language);
        }
    }
    for (const raw of candidates) {
        const tag = String(raw || '')
            .toLowerCase()
            .replace(/_/g, '-');
        if (tag.startsWith('ja')) {
            return 'ja';
        }
        if (tag.startsWith('zh')) {
            return 'zh';
        }
        if (tag.startsWith('en')) {
            return 'en';
        }
    }
    return 'ja';
}

/**
 * @param {string|undefined} raw
 * @returns {MetaverseLocale|null}
 */
export function normalizeMetaverseLocale(raw) {
    const s = String(raw || '').toLowerCase();
    if (s === 'ja' || s === 'en' || s === 'zh') {
        return s;
    }
    return null;
}

/**
 * localStorage の metaverse-settings から言語コードを読む（無効なら null）
 * @returns {MetaverseLocale|null}
 */
export function readStoredMetaverseLocale() {
    try {
        const raw = localStorage.getItem('metaverse-settings');
        if (!raw) {
            return null;
        }
        const o = JSON.parse(raw);
        return normalizeMetaverseLocale(o?.language);
    } catch {
        return null;
    }
}

/**
 * 保存済み設定があればそれを、なければブラウザ言語を currentLocale に反映する
 */
export function syncMetaverseLocaleFromStorage() {
    currentLocale = readStoredMetaverseLocale() || detectBrowserMetaverseLocale();
}

/**
 * @returns {MetaverseLocale}
 */
export function getMetaverseLocale() {
    return currentLocale;
}

/**
 * @param {string} lang
 */
export function setMetaverseLocale(lang) {
    const n = normalizeMetaverseLocale(lang);
    if (n) {
        currentLocale = n;
    }
}

/**
 * @param {string} key
 * @param {Record<string, string|number>|undefined} vars
 * @returns {string}
 */
export function t(key, vars) {
    const row = METAVERSE_STRINGS[key];
    if (!row) {
        return key;
    }
    let s = row[currentLocale] || row.ja || key;
    if (vars && typeof vars === 'object') {
        for (const [vk, vv] of Object.entries(vars)) {
            s = s.split(`{${vk}}`).join(String(vv));
        }
    }
    return s;
}

/**
 * select#graphicsTier / #pixelRatioCap などの文言を現在語に合わせる
 */
function applyMetaverseSelectOptions() {
    const gfx = document.getElementById('graphicsTier');
    if (gfx) {
        const map = {
            high: 'settings.graphicsTierHigh',
            medium: 'settings.graphicsTierMedium',
            low: 'settings.graphicsTierLow',
        };
        for (const opt of gfx.querySelectorAll('option')) {
            const k = map[opt.value];
            if (k) {
                opt.textContent = t(k);
            }
        }
    }
    const pr = document.getElementById('pixelRatioCap');
    if (pr) {
        for (const opt of pr.querySelectorAll('option')) {
            if (opt.value === 'full') {
                opt.textContent = t('settings.pixelRatioDevice');
            }
        }
    }
    const langSel = document.getElementById('language');
    if (langSel) {
        for (const opt of langSel.querySelectorAll('option')) {
            if (opt.value === 'ja') {
                opt.textContent = t('settings.langJa');
            } else if (opt.value === 'en') {
                opt.textContent = t('settings.langEn');
            } else if (opt.value === 'zh') {
                opt.textContent = t('settings.langZh');
            }
        }
    }
}

/**
 * data-i18n / data-i18n-title 等を反映し、html lang を更新する
 */
export function applyMetaverseI18nToDocument() {
    if (typeof document === 'undefined') {
        return;
    }
    const langAttr = currentLocale === 'zh' ? 'zh-Hans' : currentLocale;
    document.documentElement.lang = langAttr;

    document.querySelectorAll('[data-i18n]').forEach((el) => {
        const k = el.getAttribute('data-i18n');
        if (!k) {
            return;
        }
        el.textContent = t(k);
    });

    document.querySelectorAll('[data-i18n-html]').forEach((el) => {
        const k = el.getAttribute('data-i18n-html');
        if (!k) {
            return;
        }
        el.innerHTML = t(k);
    });

    for (const [attr, domAttr] of [
        ['data-i18n-title', 'title'],
        ['data-i18n-placeholder', 'placeholder'],
        ['data-i18n-aria-label', 'aria-label'],
    ]) {
        document.querySelectorAll(`[${attr}]`).forEach((el) => {
            const k = el.getAttribute(attr);
            if (!k) {
                return;
            }
            el.setAttribute(domAttr, t(k));
        });
    }

    applyMetaverseSelectOptions();

    const titleEl = document.querySelector('title');
    if (titleEl) {
        titleEl.textContent = t('info.appTitle');
    }
}

syncMetaverseLocaleFromStorage();

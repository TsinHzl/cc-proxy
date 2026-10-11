// 设置页 HTML 渲染：样式常量、内联脚本与组装函数。
// 脚本状态机：初始 disabled → bootstrap+load+lease 全成功后启用 → PATCH 期间禁用
// → 成功采权威快照 / 失败回滚 → 租约断开后保持禁用（setDisabled 由状态派生）。

const PAGE_STYLES = `
:root {
    color-scheme: dark;
    --page-bg: #090a0c;
    --card-bg: #15171b;
    --border: #292d33;
    --text: #e8eaed;
    --muted: #8b919a;
    --accent: #2bbbad;
    --switch-off: #30353d;
    --error: #f07178;
}
* { box-sizing: border-box; }
body {
    margin: 0;
    min-height: 100vh;
    background: var(--page-bg);
    color: var(--text);
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
main { width: min(1120px, calc(100% - 40px)); margin: 0 auto; padding: 18px 0; }
header { display: flex; align-items: baseline; gap: 16px; margin-bottom: 12px; }
h1 { margin: 0; font-size: 17px; font-weight: 650; }
header p, .description { color: var(--muted); }
header p { margin: 0; }
.section-title { margin: 0 0 6px; color: var(--muted); font-size: 11px; letter-spacing: .08em; }
.card { overflow: hidden; border: 1px solid var(--border); border-radius: 10px; background: var(--card-bg); }
.setting { display: flex; align-items: center; justify-content: space-between; gap: 24px; min-height: 48px; padding: 8px 16px; }
.setting + .setting { border-top: 1px solid var(--border); }
.copy { max-width: 860px; }
h2 { margin: 0; font-size: 13px; font-weight: 620; }
.description { margin: 0; font-size: 12px; }
.controls { display: flex; align-items: center; gap: 12px; flex: 0 0 auto; }
.switch { position: relative; flex: 0 0 auto; width: 38px; height: 22px; }
.switch input { position: absolute; opacity: 0; width: 1px; height: 1px; }
.track { display: flex; align-items: center; padding: 3px; width: 38px; height: 22px; border-radius: 999px; background: var(--switch-off); cursor: pointer; transition: background .18s ease; }
.track::after { content: ""; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform .18s ease; }
.switch input:checked + .track { background: var(--accent); }
.switch input:checked + .track::after { transform: translateX(16px); }
.switch input:focus-visible + .track { outline: 2px solid var(--accent); outline-offset: 2px; }
.switch input:disabled + .track { cursor: wait; opacity: .62; }
select {
    flex: 0 0 auto;
    height: 28px;
    padding: 0 24px 0 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--card-bg);
    color: var(--text);
    font: inherit;
    appearance: none;
    /* 自绘下拉箭头（内联 data URI 无法引用 CSS 变量）：箭头色 #8b919a 须与 --muted 保持同步 */
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' fill='none' stroke='%238b919a' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/></svg>");
    background-repeat: no-repeat;
    background-position: right 8px center;
}
select:hover:not(:disabled) { border-color: var(--accent); }
select:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
select:disabled { cursor: wait; opacity: .62; }
textarea {
    display: block;
    width: 100%;
    min-height: 132px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--page-bg);
    color: var(--text);
    font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    resize: vertical;
}
textarea:hover:not(:disabled) { border-color: var(--accent); }
textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
textarea:disabled { cursor: wait; opacity: .62; }
.prompt-block { display: block; padding: 10px 16px 14px; }
.status { min-height: 20px; margin: 8px 4px 0; color: var(--muted); }
.status.error { color: var(--error); }
@media (max-width: 640px) {
    main { width: min(100% - 24px, 1120px); padding: 12px 0; }
    header { display: block; }
    header p { margin-top: 4px; }
    .setting { min-height: 52px; padding: 8px 14px; gap: 16px; }
}
`;

const PAGE_BODY = `
<main>
    <header>
        <h1>设置</h1>
        <p>配置切换后立即保存，并在下次启动会话生效</p>
    </header>
    <p class="section-title">服务</p>
    <section class="card" aria-label="服务设置">
        <div class="setting">
            <div class="copy">
                <h2>Suggestion Mode 输入建议转发</h2>
                <p class="description">开启后转发输入建议请求并额外消耗 token；关闭时由代理返回空响应。</p>
            </div>
            <label class="switch" for="forwardSuggestionMode">
                <input id="forwardSuggestionMode" type="checkbox" disabled>
                <span class="track" aria-hidden="true"></span>
            </label>
        </div>
        <div class="setting">
            <div class="copy">
                <h2>思考内容文本化展示</h2>
                <p class="description">开启后把思考内容转为普通文本；关闭后恢复 Claude Code 原生折叠 Thinking 块。</p>
            </div>
            <label class="switch" for="thinkingAsText">
                <input id="thinkingAsText" type="checkbox" disabled>
                <span class="track" aria-hidden="true"></span>
            </label>
        </div>
        <div class="setting">
            <div class="copy">
                <h2>Effort 覆写</h2>
                <p class="description">开启后无论 Claude Code 本地 effort 设置是什么，请求均以所选档位转发。</p>
            </div>
            <div class="controls">
                <select id="effortOverrideLevel" aria-label="Effort 档位" disabled>
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                    <option value="xhigh">xhigh</option>
                    <option value="max">max</option>
                    <option value="ultracode">ultracode</option>
                </select>
                <label class="switch" for="effortOverrideEnabled">
                    <input id="effortOverrideEnabled" type="checkbox" disabled>
                    <span class="track" aria-hidden="true"></span>
                </label>
            </div>
        </div>
        <div class="setting">
            <div class="copy">
                <h2>系统提示词覆写</h2>
                <p class="description">开启后所有请求的 system 提示词被替换为下方文本（为空时不生效）。覆写可能使 Claude Code 内置工具与技能说明失效。</p>
            </div>
            <div class="controls">
                <select id="systemPromptTemplate" aria-label="系统提示词角色" disabled>
                    <option value="">选择角色…</option>
                </select>
                <label class="switch" for="systemPromptOverrideEnabled">
                    <input id="systemPromptOverrideEnabled" type="checkbox" disabled>
                    <span class="track" aria-hidden="true"></span>
                </label>
            </div>
        </div>
        <div class="prompt-block">
            <textarea id="systemPromptOverridePrompt" aria-label="自定义系统提示词" disabled spellcheck="false"></textarea>
        </div>
    </section>
    <p id="status" class="status" role="status" aria-live="polite"></p>
</main>
`;

const PAGE_SCRIPT = `
(() => {
    // 页面级 nonce 由 renderSettingsPage 注入下方 bootstrapNonce 的 JSON 字面量。
    const bootstrapNonce = __CC_PROXY_BOOTSTRAP_NONCE__;
    let headers;
    let authoritativeSnapshot = null;
    // 租约活跃状态：租约断开后必须保持禁用，PATCH 完成不得重新启用。
    let leaseActive = false;
    // 是否存在进行中的 PATCH 保存。
    let saving = false;
    const status = document.getElementById('status');
    // 布尔开关字段；effortOverride / systemPromptOverride 为嵌套字段。
    const switchFields = [
        'forwardSuggestionMode',
        'thinkingAsText',
        'effortOverrideEnabled',
        'systemPromptOverrideEnabled'
    ];
    // 所需禁用的全部控件（开关 + 档位/模板下拉 + 提示词输入框）。
    const controls = [
        ...switchFields,
        'effortOverrideLevel',
        'systemPromptTemplate',
        'systemPromptOverridePrompt'
    ];
    // 预置角色：五个高频 AI 角色的完整系统提示词（角色定义 + 行为准则 + 输出规范 + 会话指引），选择后仅填入输入框，不直接保存。
    const SYSTEM_PROMPT_TEMPLATES = [
        {
            name: '营销文案',
            text: [
                '你是一位资深营销文案专家，拥有 10 年以上品牌传播与内容营销实战经验，覆盖快消、科技、教育、本地生活等多个行业，帮助用户完成从策略到落地的全链路文案创作。',
                '',
                '# 行为准则',
                ' - 卖点先行：动笔前梳理产品最核心的差异化卖点，一支文案只围绕一个主诉求展开，次要卖点做辅助铺垫，不贪多求全。',
                ' - 用户视角：说用户关心的收益而非产品参数；把「功能」翻译成「得到」，每句自检「读者看了能得到什么」，删去自嗨式形容词。',
                ' - 平台适配：先确认投放平台（小红书 / 公众号 / 短视频脚本 / 电商详情页 / 朋友圈广告），按平台的语境、字数、排版与调性定制写法，不一份文案全平台通用。',
                ' - 人群锚定：动笔前明确目标人群的年龄层、消费动机与决策顾虑；同一产品对学生党、宝妈、白领的说话方式必须不同。',
                ' - 真实合规：不夸大功效、不虚构数据、不用绝对化用语（最、第一、唯一、国家级）；数据类卖点必须由用户提供来源，无法核实时标注「数据待验证」。',
                ' - 情绪节制：情感共鸣服务于说服逻辑，煽情段落不超过全文两成；不说教、不制造焦虑（除用户明确要求以焦虑感为主题的选题）。',
                '',
                '# 输出规范',
                ' - 输出使用简体中文，品牌名、产品名与专有术语保持原文。',
                ' - 每次交付含：2-3 个标题备选（各附适用场景一句话）+ 正文 + 一句话创作思路说明（为什么这样写、瞄准谁）。',
                ' - 小红书笔记控制在 300-600 字，首行必须是能让人停下来的钩子；公众号推文按「引子 / 主体 / 收束」三段，段落不超过 4 行。',
                ' - 短视频脚本按「钩子（前 3 秒）/ 痛点展开 / 解决方案 / 行动号召」四段，逐段标注时长参考（秒）与画面提示。',
                ' - 电商详情页文案按「卖点排序逻辑」输出：先给卖点排序及理由，再逐条展开为图文说明建议。',
                ' - 用户要求修改时，先给出当前版本的诊断结论（哪弱、为什么弱），再给修改稿；不盲目推翻重写。',
                '',
                '# 会话指引',
                ' - 用户未提供产品信息时，先问清三件事：目标人群、核心卖点、投放平台，再动笔；三要素齐备前不输出成品文案。',
                ' - 用户提供竞品文案参考时，分析其诉求结构与钩子套路后做差异化处理，不模仿照抄。',
                ' - 用户要求「更有创意一点」时，给出 2 个风格差异明显的方向（如情感共鸣型 / 数据说服型）各写一小段样稿，让用户选择后再展开。',
            ].join('\\n')
        },
        {
            name: '写作助手',
            text: [
                '你是一位专业写作助手，帮助用户完成各类文稿的构思、撰写、修改与润色，覆盖散文随笔、评论杂文、报告总结、演讲稿、书评影评等多种文体。',
                '',
                '# 行为准则',
                ' - 动笔前先明确文稿类型、目标读者、使用场景与期望语气；信息不足时先向用户确认，不得自行假设关键设定。',
                ' - 尊重用户已有的风格基调：修改稿以用户原文的语感为准，除非用户明确要求调整风格；不把用户的文字改成「AI 腔」。',
                ' - 结构优先：长文先给大纲（开头钩子 / 正文分论点及排序 / 结尾收束），确认后再展开成文；千字以上的成文必须先过大纲。',
                ' - 拒绝空洞堆砌：每个论点配具体事例、数据或场景；删去不承载信息的修饰句与车轱辘话。',
                ' - 节奏控制：长句与短句交错，连续三句以上同长度句式必须调整；重要观点用短句收尾。',
                ' - 边界诚实：引用的数据、名言、典故无法确认来源时明确标注「未经核实」，绝不编造出处与书名。',
                '',
                '# 输出规范',
                ' - 输出使用简体中文，专有名词、引用原文与术语保持原语言。',
                ' - 修改任务采用「修改后全文 + 修改说明清单」两部分输出：清单逐条注明改动位置、改动类型（删/改/重排）与理由。',
                ' - 提供 2-3 个备选标题或开头供用户挑选，每个附一句适用理由；不多于三个。',
                ' - 润色任务只改动必要的部分，并在清单中标注「保留原句」的情况，让用户看到哪些地方没动。',
                ' - 大纲输出采用层级编号（一、1.1、1.1.1）并标注每个分论点预计字数配比。',
                ' - 演讲稿额外输出：口语节奏标注（停顿 / 重音）、与听众互动的位置建议。',
                '',
                '# 会话指引',
                ' - 用户给出模糊需求（如「帮我写点东西」）时，先用一个聚焦问题澄清文体与用途，再动笔。',
                ' - 用户要求「再改改」时，先复述你理解的本轮修改重点，确认方向一致后再输出全文。',
                ' - 用户只给主题不给角度时，提供 2-3 个切入角度（正 / 反 / 侧）并各附一句话立意说明，供用户选择。',
            ].join('\\n')
        },
        {
            name: '产品经理',
            text: [
                '你是一位资深产品经理助手，帮助用户进行需求分析、方案设计、文档撰写与决策支持，覆盖 to C 与 to B 两类产品形态。',
                '',
                '# 行为准则',
                ' - 以用户价值与业务目标为决策锚点：任何方案先回答「解决谁的什么问题、如何衡量成功」，无法回答时先补齐再输出。',
                ' - 需求描述含糊时主动澄清边界：目标用户、使用场景、验收标准三者缺一不可，不得带着歧义继续输出。',
                ' - 方案输出必须给出取舍：每个设计决策附「为什么选它、放弃了什么」；不提供无代价的理想方案。',
                ' - 主动识别风险与依赖：列出技术约束、上下游依赖、合规风险，并给出应对优先级；漏掉的依赖就是返工的源头。',
                ' - MVP 思维：新功能先问「不做会怎样」，能砍的先砍掉；先跑通闭环再谈增强。',
                ' - 数据驱动：涉及行为改动的方案必须附「上线前怎么验证、上线后看什么指标」；无埋点方案的先补埋点设计。',
                '',
                '# 输出规范',
                ' - 输出使用简体中文，产品术语（PRD、MVP、AB 测试、北极星指标等）保持行业通用写法。',
                ' - PRD 结构固定：背景与目标 / 用户故事 / 功能需求（含验收标准）/ 非功能需求 / 数据埋点 / 风险与边界。',
                ' - 用户故事统一采用「作为<角色>，我想要<功能>，以便<价值>」句式，验收标准用 GIVEN/WHEN/THEN 格式。',
                ' - 优先级排序明确标注依据（价值 / 成本 / 风险），不使用无解释的高中低标签。',
                ' - 竞品分析固定输出：对比维度表（目标人群 / 核心功能 / 商业模式 / 差异点）+ 一段结论性判断，不堆砌截图式罗列。',
                ' - 方案评审意见分三级给出：必须解决（阻塞上线）/ 建议改进（不阻塞）/ 记录备查，逐条可执行。',
                '',
                '# 会话指引',
                ' - 用户提出功能想法时，先复述你理解的需求要点并确认目标用户，再展开方案。',
                ' - 涉及数据指标时，主动询问现有埋点与基线数据；无数据支撑的判断需显式标注「假设」。',
                ' - 用户纠结两个方案时，构造最小对比表（成本 / 收益 / 风险 / 可逆性）帮助决策，不替用户拍板。',
            ].join('\\n')
        },
        {
            name: '数据分析师',
            text: [
                '你是一位严谨的数据分析师助手，帮助用户完成数据清洗、探索分析、可视化建议、实验设计与结论解读，使用 SQL、Python（pandas）等工具链。',
                '',
                '# 行为准则',
                ' - 先理解数据再动手分析：确认字段含义、统计口径、时间范围与样本量，口径不清时先向用户确认，不猜字段语义。',
                ' - 区分相关与因果：任何结论只陈述数据支持的部分，不得从相关性直接推断因果；用户要求因果结论时建议实验设计（AB 测试 / 双重差分）。',
                ' - 展示不确定性：给出关键数字时附样本量与波动范围；小样本结论必须标注可靠性限制。',
                ' - 警惕常见陷阱：辛普森悖论、幸存者偏差、多重比较问题、均值陷阱（长尾分布应看分位数）；发现时主动向用户指出。',
                ' - 先探索后建模：正式分析前先看分布、缺失率、异常值；跳过探索直接出结论是本岗位最大忌讳。',
                ' - 结论可复现：分析步骤描述到「别人拿着也能跑出来」的程度，关键筛选条件与计算口径逐条列明。',
                '',
                '# 输出规范',
                ' - 输出使用简体中文，统计术语（p 值、置信区间、分位数、标准差等）保持标准定义不意译。',
                ' - 分析结论固定结构：结论先行（一句话）/ 关键数据支撑 / 口径与局限说明 / 建议的下一步动作。',
                ' - 涉及 SQL 或代码时使用带注释的代码块，注明每步对数据集形状的改变（行数变化），SQL 注明执行的引擎方言（MySQL / Hive / Spark）。',
                ' - 图表建议必须说明：图表类型、横纵轴字段、适用理由；趋势用折线、构成用堆叠柱或饼、分布用直方图或箱线；不推荐 3D 饼图、双层嵌套饼图等失真图表。',
                ' - 数字格式统一：大数用万 / 亿中文单位或千分位，比例保留一位小数；同一结论内口径一致。',
                ' - 给出数据需求清单时按「必须 / 可选」分级，注明每个字段的业务含义与期望粒度。',
                '',
                '# 会话指引',
                ' - 用户直接要「分析一下」时，先确认数据来源、格式与本次分析的业务问题，再开始。',
                ' - 结论与用户预期相悖时，如实陈述并给出验证该反直觉结论的具体方法，不迎合预期修正数据。',
                ' - 用户提出「数据有问题」的质疑时，给出排查顺序：口径差异 → 统计时间窗 → 去重逻辑 → 源头采集，逐层定位而不是重跑一遍了事。',
            ].join('\\n')
        },
        {
            name: '翻译专家',
            text: [
                '你是一位专业翻译专家，在中英互译基础上覆盖日、韩、法、德等常见语种，兼顾信、达、雅与专业领域准确性，持有 CATTI 一级与多年本地化项目经验。',
                '',
                '# 行为准则',
                ' - 忠实优先：不增译、不漏译、不主观改写原文语义；原文有歧义时译出主要义项并注明歧义存在。',
                ' - 语境适配：先判断文本类型（法律 / 技术 / 文学 / 营销 / 日常），译文风格随文体调整而非一刀切；法律文本严谨精确优先，营销文本感染力优先。',
                ' - 术语一致：同一术语在全文中译法统一；首次出现时括注原文，专业领域优先采用该领域通用译法；术语表冲突时向用户确认以哪个为准。',
                ' - 文化转换：习语、双关、梗按目标语表达习惯处理，采用意译并保留原文风味，逐字硬译导致不可读时必须意译。',
                ' - 数字与格式：日期、单位、货币按目标语惯例转换（如中文「万」与英文「10k」的换算），并保持与原文数字精确一致，不四舍五入。',
                ' - 保密意识：用户提供的未公开稿件内容仅用于本次翻译任务，不主动复述到无关回答中。',
                '',
                '# 输出规范',
                ' - 默认只输出译文，不加解释；用户未说明目标语言时，中文原文译为英文、外文原文译为简体中文。',
                ' - 用户要求对照或审校时，采用「译文 / 逐条说明」结构：说明列出关键取舍点（术语选择、语序调整、文化处理）。',
                ' - 原文疑似语法错误或笔误时，按最可能的意图翻译，并在译文后用「译注」标出疑似原文问题。',
                ' - 格式保真：原文的段落、列表、表格结构在译文中原样保留；代码注释只译注释不改变量名。',
                ' - 长文翻译先译第一段给用户确认术语与风格基准，确认后再完成全文。',
                ' - 专业领域文本（法律 / 医疗 / 金融）在译文开头标注「领域专业文本，建议母语审校复核」。',
                '',
                '# 会话指引',
                ' - 用户仅给出单词或短语时，给出主要译法并附使用场景差异（如正式 / 口语 / 领域专属）。',
                ' - 用户要求「润色译文」时，先确认是向原文靠拢（准确）还是向读者靠拢（流畅），再输出修改版。',
                ' - 用户提供术语表时，先通读并确认优先级（用户术语表 > 领域通用 > 自行判断），翻译全程严格遵守。',
            ].join('\\n')
        }
    ];

    // disabled 由状态派生：租约不活跃或有保存进行中 → 禁用。
    function setDisabled(disabled) {
        const effective = disabled || !leaseActive || saving;
        for (const key of controls) {
            document.getElementById(key).disabled = effective;
        }
    }

    function applySettings(data) {
        for (const key of switchFields) {
            const value = key === 'effortOverrideEnabled'
                ? data.effortOverride?.enabled
                : key === 'systemPromptOverrideEnabled'
                    ? data.systemPromptOverride?.enabled
                    : data[key];
            document.getElementById(key).checked = value;
        }
        document.getElementById('effortOverrideLevel').value
            = data.effortOverride?.level ?? 'high';
        document.getElementById('systemPromptOverridePrompt').value
            = data.systemPromptOverride?.prompt ?? '';
        // 程序化回填（初次加载/保存后回填/失败回滚）不触发 input 事件，下拉需手动同步。
        syncTemplateSelect();
    }

    function acceptSettings(data) {
        authoritativeSnapshot = {
            forwardSuggestionMode: data.forwardSuggestionMode,
            thinkingAsText: data.thinkingAsText,
            effortOverride: {
                enabled: data.effortOverride?.enabled,
                level: data.effortOverride?.level
            },
            systemPromptOverride: {
                enabled: data.systemPromptOverride?.enabled,
                prompt: data.systemPromptOverride?.prompt
            }
        };
        applySettings(authoritativeSnapshot);
    }

    function show(message, isError = false) {
        status.textContent = message;
        status.classList.toggle('error', isError);
    }

    async function bootstrap() {
        const response = await fetch('/api/bootstrap', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nonce: bootstrapNonce })
        });
        // nonce 为一次性凭据：浏览器恢复标签页 / bfcache / 重复打开旧地址时
        // 会复用过期或已消费的 nonce，服务端返回非 2xx。此时整页重载一次
        // 换取新 nonce；sessionStorage 防止服务异常时无限刷新循环。
        if (!response.ok) {
            if (!sessionStorage.getItem('bootstrap-retried')) {
                sessionStorage.setItem('bootstrap-retried', '1');
                location.reload();
                return new Promise(() => {});
            }
            throw new Error('页面认证失败，请重新打开设置页');
        }
        sessionStorage.removeItem('bootstrap-retried');
        const { data } = await response.json();
        headers = { 'X-CC-Proxy-Token': data.token };
    }

    async function load() {
        const response = await fetch('/api/settings', { headers });
        if (!response.ok) throw new Error('读取设置失败');
        const { data } = await response.json();
        acceptSettings(data);
        // 初次加载预填：串行在 acceptSettings 之后，避免与权威快照回填竞争。
        await prefillCapturedPrompt();
    }

    // 拉取捕获的 CC 默认系统提示词：无捕获数据或失败时返回 null。
    async function fetchCapturedPrompt() {
        try {
            const captured = await fetch('/api/captured-system-prompt', { headers });
            if (!captured.ok) return null;
            const { data } = await captured.json();
            return data?.prompt ?? null;
        } catch {
            return null;
        }
    }

    // 预填进行中标志：互斥 load 预填与开关开启预填两条并发链路。
    let prefilling = false;

    // 预填入口：输入框为空且代理已捕获 CC 默认提示词时展示在输入框内
    //（与开关状态无关，用户可直接修改；无捕获数据保持为空）。
    // persist 为 true 时同步 PATCH prompt（开关开启路径），保证展示与生效一致。
    async function prefillCapturedPrompt(persist = false) {
        const textarea = document.getElementById('systemPromptOverridePrompt');
        try {
            if (!textarea || textarea.value || prefilling) return;
            prefilling = true;
            const prompt = await fetchCapturedPrompt();
            // 拉取期间用户可能已输入：仅当仍为空时填入，不覆盖用户内容。
            if (!prompt || textarea.value) return;
            textarea.value = prompt;
            if (persist) await patchSetting('systemPromptOverride.prompt', prompt);
        } catch {
            // 预填失败静默忽略，不阻断页面初始化或开关保存。
        } finally {
            prefilling = false;
        }
    }

    for (const key of switchFields) {
        const input = document.getElementById(key);
        input.addEventListener('change', async () => {
            const requestedValue = input.checked;
            // 嵌套字段对应的 API key；顶层布尔 key 保持原名。
            const apiKey = key === 'effortOverrideEnabled'
                ? 'effortOverride.enabled'
                : key === 'systemPromptOverrideEnabled'
                    ? 'systemPromptOverride.enabled'
                    : key;
            saving = true;
            setDisabled(true);
            try {
                // 系统提示词开关开启且输入框为空：预填捕获的 CC 默认提示词并
                // 同步 PATCH prompt（persist=true），再提交 enabled——保证首次
                // 开启即带着预填内容生效，展示与生效一致。
                if (key === 'systemPromptOverrideEnabled' && requestedValue) {
                    await prefillCapturedPrompt(true);
                }
                await patchSetting(apiKey, requestedValue);
                show('设置已保存，将在下次启动会话生效');
            } catch (error) {
                if (authoritativeSnapshot) {
                    applySettings(authoritativeSnapshot);
                }
                show(error.message, true);
            } finally {
                saving = false;
                // 仅在租约仍活跃时恢复启用；租约已断开则保持禁用。
                setDisabled(!leaseActive);
            }
        });
    }

    async function patchSetting(key, value) {
        const response = await fetch('/api/settings', {
            method: 'PATCH',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ key, value })
        });
        if (!response.ok) throw new Error('保存失败');
        const { data } = await response.json();
        acceptSettings(data);
    }

    // Effort 档位下拉：提交 effortOverride.level，保存期间禁用全部控件。
    document.getElementById('effortOverrideLevel').addEventListener('change', async (event) => {
        const select = event.currentTarget;
        const requestedValue = select.value;
        saving = true;
        setDisabled(true);
        try {
            await patchSetting('effortOverride.level', requestedValue);
            show('设置已保存，将在下次启动会话生效');
        } catch (error) {
            if (authoritativeSnapshot) {
                applySettings(authoritativeSnapshot);
            }
            show(error.message, true);
        } finally {
            saving = false;
            // 仅在租约仍活跃时恢复启用；租约已断开则保持禁用。
            setDisabled(!leaseActive);
        }
    });

    // 系统提示词角色下拉：仅填入输入框不保存（用户还有修改机会）。
    const templateSelect = document.getElementById('systemPromptTemplate');
    for (const { name, text } of SYSTEM_PROMPT_TEMPLATES) {
        const option = document.createElement('option');
        option.value = text;
        option.textContent = name;
        templateSelect.appendChild(option);
    }
    // 下拉选中项始终反映输入框当前内容：内容与某条模板一致时显示该模板名，
    // 否则（手动修改、预填捕获提示词、空）回落占位项。value 存模板全文便于比对。
    function syncTemplateSelect() {
        const current = document.getElementById('systemPromptOverridePrompt').value;
        let matched = '';
        for (const option of templateSelect.options) {
            if (option.value && option.value === current) {
                matched = current;
                break;
            }
        }
        templateSelect.value = matched;
    }
    templateSelect.addEventListener('change', (event) => {
        const select = event.currentTarget;
        if (select.value) {
            document.getElementById('systemPromptOverridePrompt').value = select.value;
        }
        // 选择后保留所选模板名；输入框内容随后变化时由 input 事件同步。
        syncTemplateSelect();
    });

    // 输入框内容变化时同步下拉显示（手动编辑后不再匹配模板则回占位项）。
    document.getElementById('systemPromptOverridePrompt').addEventListener('input', syncTemplateSelect);

    // 系统提示词输入框：blur 时与权威快照不同则提交 prompt。
    document.getElementById('systemPromptOverridePrompt').addEventListener('blur', async (event) => {
        const textarea = event.currentTarget;
        const snapshotPrompt = authoritativeSnapshot?.systemPromptOverride?.prompt;
        if (textarea.value === snapshotPrompt) return;
        saving = true;
        setDisabled(true);
        try {
            await patchSetting('systemPromptOverride.prompt', textarea.value);
            show('设置已保存，将在下次启动会话生效');
        } catch (error) {
            if (authoritativeSnapshot) {
                applySettings(authoritativeSnapshot);
            }
            show(error.message, true);
        } finally {
            saving = false;
            // 仅在租约仍活跃时恢复启用；租约已断开则保持禁用。
            setDisabled(!leaseActive);
        }
    });

    async function openLease() {
        const response = await fetch('/api/session', { headers });
        if (!response.ok || !response.body) throw new Error('设置页面连接失败');
        return response.body;
    }

    async function initialize() {
        await bootstrap();
        const [, body] = await Promise.all([load(), openLease()]);
        leaseActive = true;
        setDisabled(false);
        await body.pipeTo(new WritableStream());
        // 服务端正常关闭租约（超时/单租户抢占）也视为断开并保持禁用。
        throw new Error('设置页面连接已断开');
    }

    initialize().catch((error) => {
        leaseActive = false;
        setDisabled(true);
        show(error.message, true);
    });
})();
`;

export function renderSettingsPage(bootstrapNonce = '') {
    // 函数替换：避免替换串中的 $& 等特殊模式破坏注入结果；
    // stringify 后转义 <，防止 </script> 从内联脚本标签逃逸。
    const script = PAGE_SCRIPT.replace(
        '__CC_PROXY_BOOTSTRAP_NONCE__',
        () => JSON.stringify(bootstrapNonce).replace(/</g, '\\u003c')
    );
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cc-proxy 设置</title>
<style>${PAGE_STYLES}</style>
</head>
<body>${PAGE_BODY}
<script>${script}</script>
</body>
</html>`;
}

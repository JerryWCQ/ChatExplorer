import { useState } from "react";
import { modelInfo } from "../core/model";
import { ICON_SIZE, type Chat } from "../core/schema";
import { ChatIcon, FolderIcon, ModelTag } from "../ui/ChatIcon";
import { displayName, formatDate, isRenamed, monthLabel } from "../ui/format";
import { Icon, SolidIcon } from "../ui/Icon";
import { translator, type Lang } from "../ui/i18n";
import { FOLDERS, MODEL_STRINGS, SAMPLES } from "./fixtures";

/**
 * The component gallery from DESIGN 10. Every component appears in each state
 * it can reach, so the two themes and two languages can be compared before any
 * of this gets wired to real data.
 */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="gx-section">
      <h2 className="gx-h2">{title}</h2>
      <div className="gx-body">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <div className="gx-row">
      {label && <span className="gx-label">{label}</span>}
      <div className="gx-items">{children}</div>
    </div>
  );
}

const NOW = new Date("2026-09-17T18:00:00Z").getTime();

export function Gallery({ lang }: { lang: Lang }) {
  const t = translator(lang);
  const [iconSize, setIconSize] = useState<number>(ICON_SIZE.default);
  const zh = lang === "zh-CN";
  const s = (cn: string, en: string) => (zh ? cn : en);

  const hero = SAMPLES[0]!;
  const noSummary = SAMPLES[4]!;
  const broken = SAMPLES[5]!;
  const untitled = SAMPLES[3]!;

  return (
    <div className="gx-root">
      {/* ---- colour and type -------------------------------------------- */}
      <Section title={s("中性色 / 强调色 / 状态色", "Neutrals, accent, status")}>
        <Row>
          {[
            ["--bg-page", "page"],
            ["--bg-panel", "panel"],
            ["--bg-raised", "raised"],
            ["--bg-hover", "hover"],
            ["--bg-selected", "selected"],
            ["--bg-selected-hover", "sel+hover"],
            ["--border", "border"],
            ["--border-strong", "strong"],
            ["--accent", "accent"],
            ["--accent-hover", "accent+"],
            ["--danger", "danger"],
            ["--success", "success"]
          ].map(([token, name]) => (
            <div key={token} className="gx-swatch">
              <span style={{ background: `var(${token})` }} />
              <code>{name}</code>
            </div>
          ))}
        </Row>
        <Row label={s("文字", "Text")}>
          <span style={{ color: "var(--text-primary)" }}>primary</span>
          <span style={{ color: "var(--text-secondary)" }}>secondary</span>
          <span style={{ color: "var(--text-tertiary)" }}>tertiary</span>
          <span style={{ color: "var(--text-disabled)" }}>disabled</span>
        </Row>
        <Row label={s("字号", "Scale")}>
          {(["xs", "sm", "md", "lg", "xl"] as const).map((k) => (
            <span key={k} style={{ fontSize: `var(--fs-${k})` }}>
              {k} 中文 Aa
            </span>
          ))}
        </Row>
      </Section>

      {/* ---- model tags -------------------------------------------------- */}
      <Section title={s("模型标签", "Model tags")}>
        <Row>
          {MODEL_STRINGS.map((m) => (
            <ModelTag key={m} info={modelInfo(m)} />
          ))}
        </Row>
      </Section>

      {/* ---- chat icon size ramp ----------------------------------------- */}
      <Section title={s("对话图标 · 尺寸连续缩放", "Chat icon · continuous scale")}>
        <Row label={s("两档缩略图（<90 横线，≥90 可读）", "Two tiers (<90 lines, ≥90 text)")}>
          {[40, 64, 89, 90, 128, 180].map((size) => (
            <div key={size} className="gx-stack">
              <ChatIcon size={size} model={hero.model} summary={hero.summary} starred />
              <code>{size}px</code>
            </div>
          ))}
        </Row>
        <Row label={s("拖动试试", "Drag me")}>
          <input
            className="slider"
            type="range"
            min={ICON_SIZE.min}
            max={ICON_SIZE.max}
            value={iconSize}
            onChange={(e) => setIconSize(Number(e.target.value))}
          />
          <code>{iconSize}px</code>
          <ChatIcon size={iconSize} model={hero.model} summary={hero.summary} />
        </Row>
      </Section>

      <Section title={s("对话图标 · 模型 × 状态", "Chat icon · model × state")}>
        <Row label={s("模型系列", "Series")}>
          {MODEL_STRINGS.map((m) => (
            <ChatIcon key={m} size={72} model={m} summary={hero.summary} />
          ))}
        </Row>
        <Row label={s("状态", "States")}>
          <div className="gx-stack">
            <ChatIcon size={72} model={hero.model} summary={hero.summary} starred />
            <code>{s("收藏（只读）", "starred")}</code>
          </div>
          <div className="gx-stack">
            <ChatIcon size={72} model={hero.model} summary={hero.summary} flagged />
            <code>{s("标记（本地）", "marked")}</code>
          </div>
          <div className="gx-stack">
            <ChatIcon size={72} model={hero.model} summary={hero.summary} starred flagged />
            <code>{s("两者都有", "both")}</code>
          </div>
          <div className="gx-stack">
            <ChatIcon size={72} model={hero.model} summary={hero.summary} isShortcut />
            <code>{s("快捷方式", "shortcut")}</code>
          </div>
          <div className="gx-stack">
            <ChatIcon size={72} model={broken.model} summary={broken.summary} missing />
            <code>{s("失效", "broken")}</code>
          </div>
          <div className="gx-stack">
            <ChatIcon size={72} model={noSummary.model} summary="" />
            <code>{s("无摘要", "no summary")}</code>
          </div>
        </Row>
        <Row label={s("小于 64px 隐藏标签", "Tag drops below 64px")}>
          {[40, 48, 56, 64, 72].map((size) => (
            <ChatIcon key={size} size={size} model={hero.model} summary={hero.summary} isShortcut />
          ))}
        </Row>
      </Section>

      {/* ---- folder icon -------------------------------------------------- */}
      <Section title={s("文件夹图标", "Folder icon")}>
        <Row>
          <div className="gx-stack">
            <FolderIcon size={72} />
            <code>{s("空", "empty")}</code>
          </div>
          <div className="gx-stack">
            <FolderIcon size={72} peek={MODEL_STRINGS.slice(0, 3)} />
            <code>{s("有内容", "with contents")}</code>
          </div>
          <div className="gx-stack">
            <FolderIcon size={72} peek={MODEL_STRINGS.slice(0, 2)} dropTarget />
            <code>{s("拖拽落点", "drop target")}</code>
          </div>
          <div className="gx-stack">
            <FolderIcon size={40} peek={MODEL_STRINGS.slice(0, 3)} />
            <code>{s("40px 不露纸", "40px, no peek")}</code>
          </div>
        </Row>
      </Section>

      {/* ---- grid cells --------------------------------------------------- */}
      <Section title={s("图标视图 · 格子状态", "Icon view · cell states")}>
        <Row>
          {(
            [
              ["", s("默认", "default")],
              [" is-hover", s("悬停", "hover")],
              [" is-selected", s("选中", "selected")],
              [" is-focus", s("键盘焦点", "focus")],
              [" is-cut", s("已剪切", "cut")],
              [" is-dragging", s("拖拽中", "dragging")]
            ] as const
          ).map(([cls, label]) => (
            <div key={label} className="gx-stack">
              <div className={`grid-cell${cls}`} style={{ width: 96 }}>
                <span className="cell-check">
                  <input
                    className="checkbox"
                    type="checkbox"
                    readOnly
                    checked={cls === " is-selected"}
                  />
                </span>
                <ChatIcon size={64} model={hero.model} summary={hero.summary} />
                <NameCell chat={hero} lang={lang} expanded={false} />
              </div>
              <code>{label}</code>
            </div>
          ))}
          {/* Drop highlight exists only on folder cells (user feedback):
              a chat cannot receive a drop. */}
          <div className="gx-stack">
            <div className="grid-cell is-drop" style={{ width: 96 }}>
              <FolderIcon size={64} peek={[hero.model]} dropTarget />
              <div className="name-slot">
                <div className="name-label">学习</div>
              </div>
            </div>
            <code>{s("落点（仅文件夹）", "drop (folders only)")}</code>
          </div>
          <div className="gx-stack">
            <div className="grid-cell is-selected" style={{ width: 96 }}>
              <ChatIcon size={64} model={hero.model} summary={hero.summary} />
              <NameCell chat={hero} lang={lang} expanded />
            </div>
            <code>{s("选中展开全名", "expanded label")}</code>
          </div>
          <div className="gx-stack">
            <div className="grid-cell" style={{ width: 96 }}>
              <ChatIcon size={64} model={untitled.model} summary={untitled.summary} />
              <input className="input" style={{ width: 88, height: 22 }} defaultValue="重命名中" />
            </div>
            <code>{s("重命名输入", "renaming")}</code>
          </div>
        </Row>
      </Section>

      {/* ---- tree --------------------------------------------------------- */}
      <Section title={s("导航树", "Navigation tree")}>
        <div className="gx-panel" style={{ width: 240 }}>
          <div className="tree-node is-selected">
            <span className="tree-twisty" />
            <Icon name="inbox" size={15} />
            <span className="tree-label">{t("navUnfiled")}</span>
            <span className="tree-count">1296</span>
          </div>
          <div className="tree-node">
            <span className="tree-twisty" />
            <Icon name="clock" size={15} />
            <span className="tree-label">{t("navRecent")}</span>
          </div>
          <div className="tree-node">
            <span className="tree-twisty" />
            <Icon name="bookmark" size={15} />
            <span className="tree-label">{t("navFlagged")}</span>
            <span className="tree-count">3</span>
          </div>
          <div className="tree-node">
            <span className="tree-twisty" />
            <SolidIcon name="star" size={14} />
            <span className="tree-label">{t("navStarred")}</span>
            <span className="tree-count">4</span>
          </div>
          <div className="tree-node">
            <span className="tree-twisty" />
            <Icon name="unlink" size={15} />
            <span className="tree-label">{t("navMissing")}</span>
          </div>
          <div className="tree-node">
            <span className="tree-twisty" />
            <Icon name="eyeOff" size={15} />
            <span className="tree-label">{t("navHidden")}</span>
            <span className="tree-count">12</span>
          </div>
          <div className="menu-sep" />
          <div className="tree-node">
            <span className="tree-twisty is-open">
              <Icon name="chevronRight" size={14} />
            </span>
            <Icon name="folder" size={15} />
            <span className="tree-label">学习</span>
            <span className="tree-count">87</span>
          </div>
          <div className="tree-node is-drop" style={{ paddingLeft: 26 }}>
            <span className="tree-twisty" />
            <Icon name="folder" size={15} />
            <span className="tree-label">SAT</span>
            <span className="tree-count">21</span>
          </div>
          <div className="tree-node" style={{ paddingLeft: 26 }}>
            <span className="tree-twisty" />
            <Icon name="folder" size={15} />
            <span className="tree-label">
              一个很长的文件夹名字会被截断显示省略号
            </span>
          </div>
        </div>
      </Section>

      {/* ---- details view -------------------------------------------------- */}
      <Section title={s("详情视图", "Details view")}>
        <div className="gx-panel" style={{ width: 640, padding: 0 }}>
          <div className="details-header">
            <div style={{ width: 34 }}>
              <input className="checkbox" type="checkbox" readOnly />
            </div>
            <div style={{ flex: 1 }}>
              {t("colName")}
              <Icon name="chevronDown" size={12} />
              <span className="col-resize" />
            </div>
            <div style={{ width: 130 }}>
              {t("colUpdated")}
              <span className="col-resize" />
            </div>
            <div style={{ width: 96 }}>
              {t("colModel")}
              <span className="col-resize" />
            </div>
            <div style={{ width: 110 }}>{t("colLocation")}</div>
          </div>
          {SAMPLES.slice(0, 4).map((c, i) => (
            <div
              key={c.uuid}
              className={`details-row is-comfortable${i === 1 ? " is-selected" : ""}${
                c.status === "missing" ? " is-missing" : ""
              }`}
            >
              <div style={{ width: 34 }}>
                <input className="checkbox" type="checkbox" readOnly checked={i === 1} />
              </div>
              <div style={{ flex: 1 }}>
                <ChatIcon size={16} model={c.model} summary={c.summary} />
                <span className="row-stack">
                  <span className="row-name">{displayName(c, lang, t)}</span>
                  <span className="row-secondary">{c.summary || t("noSummary")}</span>
                </span>
              </div>
              <div className="row-secondary" style={{ width: 130 }}>
                {formatDate(c.updatedAt, lang, t, NOW)}
              </div>
              <div style={{ width: 96 }}>
                <ModelTag info={modelInfo(c.model)} />
              </div>
              <div className="row-secondary" style={{ width: 110 }}>
                {i % 2 ? "学习 / SAT" : t("navUnfiled")}
              </div>
            </div>
          ))}
          {SAMPLES.slice(0, 2).map((c, i) => (
            <div
              key={`c-${c.uuid}`}
              className={`details-row is-compact${i === 0 ? " is-hover" : ""}`}
            >
              <div style={{ width: 34 }}>
                <input className="checkbox" type="checkbox" readOnly />
              </div>
              <div style={{ flex: 1 }}>
                <ChatIcon size={16} model={c.model} summary={c.summary} />
                <span className="row-name">{displayName(c, lang, t)}</span>
              </div>
              <div className="row-secondary" style={{ width: 130 }}>
                {formatDate(c.updatedAt, lang, t, NOW)}
              </div>
              <div style={{ width: 96 }}>
                <ModelTag info={modelInfo(c.model)} />
              </div>
              <div className="row-secondary" style={{ width: 110 }}>
                Work
              </div>
            </div>
          ))}
        </div>
        <Row label={s("行密度", "Density")}>
          <code>{s("紧凑 28px（下两行） / 舒适 48px（上四行）", "compact 28 / comfortable 48")}</code>
        </Row>
      </Section>

      {/* ---- group header, breadcrumb, search ------------------------------ */}
      <Section title={s("分组标题 / 面包屑 / 搜索", "Group header, breadcrumb, search")}>
        <div className="gx-panel" style={{ width: 420, padding: 0 }}>
          <div className="group-header">
            <Icon name="chevronDown" size={14} />
            {monthLabel("2026-09-01T00:00:00Z", lang)}
            <span className="tree-count">128</span>
          </div>
          <div className="group-header">
            <Icon name="chevronRight" size={14} />
            {monthLabel("2026-08-01T00:00:00Z", lang)}
            <span className="tree-count">94</span>
          </div>
        </div>

        <Row>
          <div className="crumbs" style={{ width: 340, flex: "none" }}>
            <button className="crumb">{s("全部", "All")}</button>
            <span className="crumb-sep">
              <Icon name="chevronRight" size={13} />
            </span>
            <button className="crumb">学习</button>
            <span className="crumb-sep">
              <Icon name="chevronRight" size={13} />
            </span>
            <button className="crumb is-current">SAT</button>
          </div>
          <div className="search-box">
            <Icon name="search" size={14} />
            <input placeholder={t("searchIn", { name: "SAT" })} readOnly />
          </div>
        </Row>

        <Row label={s("命中高亮", "Match highlight")}>
          <span>
            ChatExplorer 的<mark>同步</mark>层设计与 IndexedDB 取舍
          </span>
        </Row>
      </Section>

      {/* ---- controls ------------------------------------------------------ */}
      <Section title={s("控件", "Controls")}>
        <Row label={s("按钮", "Buttons")}>
          <button className="btn is-primary">{t("openOnClaude")}</button>
          <button className="btn">{t("moveTo")}</button>
          <button className="btn is-danger">{t("delete")}</button>
          <button className="btn" disabled>
            {t("paste")}
          </button>
          <button className="btn is-icon">
            <Icon name="refresh" />
          </button>
          <button className="btn is-icon is-active">
            <Icon name="panelRight" />
          </button>
          <button className="btn is-icon" disabled>
            <Icon name="arrowLeft" />
          </button>
        </Row>
        <Row label={s("输入", "Inputs")}>
          <input className="input" defaultValue="SAT 数学错题整理" style={{ width: 200 }} />
          <input className="input" placeholder={t("quickJumpPlaceholder")} style={{ width: 200 }} />
          <input className="input" defaultValue={s("禁用", "disabled")} disabled />
        </Row>
        <Row label={s("勾选 / 开关 / 滑块", "Check, switch, slider")}>
          <input className="checkbox" type="checkbox" readOnly />
          <input className="checkbox" type="checkbox" readOnly checked />
          <input
            className="checkbox"
            type="checkbox"
            readOnly
            ref={(el) => {
              if (el) el.indeterminate = true;
            }}
          />
          <input className="checkbox" type="checkbox" disabled />
          <input className="switch" type="checkbox" readOnly />
          <input className="switch" type="checkbox" readOnly checked />
          <input className="slider" type="range" defaultValue={60} />
        </Row>
      </Section>

      {/* ---- menus --------------------------------------------------------- */}
      <Section title={s("右键菜单 / 下拉菜单", "Context and dropdown menus")}>
        <Row>
          <div className="menu" style={{ width: 210 }}>
            <button className="menu-item">
              <Icon name="externalLink" size={15} />
              {t("openOnClaude")}
              <span className="menu-shortcut">Enter</span>
            </button>
            <div className="menu-sep" />
            <button className="menu-item">
              <Icon name="scissors" size={15} />
              {t("cut")}
              <span className="menu-shortcut">Ctrl+X</span>
            </button>
            <button className="menu-item">
              <Icon name="copy" size={15} />
              {t("copyShortcut")}
              <span className="menu-shortcut">Ctrl+C</span>
            </button>
            <button className="menu-item" disabled>
              <Icon name="clipboard" size={15} />
              {t("paste")}
              <span className="menu-shortcut">Ctrl+V</span>
            </button>
            <div className="menu-sep" />
            <button className="menu-item">
              <Icon name="pencil" size={15} />
              {t("rename")}
              <span className="menu-shortcut">F2</span>
            </button>
            <button className="menu-item">
              <Icon name="bookmark" size={15} />
              {t("navFlagged")}
            </button>
            <button className="menu-item is-danger">
              <Icon name="trash" size={15} />
              {t("delete")}
              <span className="menu-shortcut">Del</span>
            </button>
          </div>

          {/* State rows are marked with a dot in a fixed gutter, Explorer-style
              (user decision); a tick reads as "done" rather than "current". */}
          <div className="menu" style={{ width: 190 }}>
            <button className="menu-item">
              <span className="menu-mark">
                <span className="menu-dot" />
              </span>
              {t("sortUpdated")}
            </button>
            <button className="menu-item">
              <span className="menu-mark" />
              {t("sortName")}
            </button>
            <button className="menu-item">
              <span className="menu-mark" />
              {t("sortModel")}
            </button>
            <div className="menu-sep" />
            <button className="menu-item">
              <span className="menu-mark" />
              {t("ascending")}
            </button>
            <button className="menu-item">
              <span className="menu-mark">
                <span className="menu-dot" />
              </span>
              {t("descending")}
            </button>
          </div>
        </Row>
      </Section>

      {/* ---- floating feedback --------------------------------------------- */}
      <Section title={s("提示 / Toast / 弹窗 / 提示条", "Tooltip, toast, dialog, banner")}>
        <Row>
          <div className="tooltip">
            <strong>{displayName(hero, lang, t)}</strong>
            <p>{hero.summary}</p>
            <span style={{ color: "var(--text-tertiary)" }}>
              {formatDate(hero.updatedAt, lang, t, NOW)}
            </span>
          </div>
          <div className="toast">
            <span>{t("toastDeleted", { n: 3 })}</span>
            <button>{t("undo")}</button>
          </div>
        </Row>

        <Row>
          <div className="dialog">
            <h2>{t("confirmDeleteFolderTitle", { name: "SAT" })}</h2>
            <p>{t("confirmDeleteFolderBody")}</p>
            <div className="dialog-actions">
              <button className="btn">{t("cancel")}</button>
              <button className="btn is-primary">{t("confirm")}</button>
            </div>
          </div>
        </Row>

        <div className="banner" style={{ width: "100%" }}>
          <Icon name="alert" size={16} className="banner-icon" />
          <span>{t("sessionExpired")}</span>
          <button>{t("openClaudeToSignIn")}</button>
        </div>
      </Section>

      {/* ---- preview pane --------------------------------------------------- */}
      <Section title={s("预览窗格", "Preview pane")}>
        <div className="gx-panel gx-preview" style={{ width: 300 }}>
          <ChatIcon size={120} model={hero.model} summary={hero.summary} starred />
          <h3 className="gx-preview-title">{displayName(hero, lang, t)}</h3>
          <div className="row-secondary">{t("officialTitle", { name: hero.remoteName })}</div>
          <dl className="gx-meta">
            <dt>{t("metaModel")}</dt>
            <dd>
              <ModelTag info={modelInfo(hero.model)} />
            </dd>
            <dt>{t("metaUpdated")}</dt>
            <dd>{formatDate(hero.updatedAt, lang, t, NOW)}</dd>
            <dt>{t("metaCreated")}</dt>
            <dd>{formatDate(hero.createdAt, lang, t, NOW)}</dd>
            <dt>{t("metaLocation")}</dt>
            <dd>
              <a href="#loc">学习 / SAT</a>
            </dd>
            <dt>{t("metaShortcuts")}</dt>
            <dd>Work</dd>
          </dl>
          <p className="gx-summary">{hero.summary}</p>
          <div className="dialog-actions" style={{ justifyContent: "stretch" }}>
            <button className="btn is-primary" style={{ flex: 1 }}>
              {t("openOnClaude")}
            </button>
            <button className="btn">{t("moveTo")}</button>
          </div>
        </div>
      </Section>

      {/* ---- empty states and skeleton --------------------------------------- */}
      <Section title={s("空状态 / 骨架 / 状态栏", "Empty states, skeleton, status bar")}>
        <Row>
          <div className="gx-panel" style={{ width: 260 }}>
            <div className="empty-state">
              <Icon name="check_square" size={32} />
              <h3>{t("emptyUnfiledTitle")}</h3>
              <p>{t("emptyUnfiledBody")}</p>
            </div>
          </div>
          <div className="gx-panel" style={{ width: 260 }}>
            <div className="empty-state">
              <Icon name="search" size={32} />
              <h3>{t("emptySearchTitle")}</h3>
              <p>{t("emptySearchBody", { q: "bigram" })}</p>
            </div>
          </div>
          <div className="gx-panel" style={{ width: 200 }}>
            <div style={{ display: "flex", gap: "var(--sp-3)" }}>
              {[0, 1, 2].map((i) => (
                <div key={i} style={{ display: "grid", gap: "var(--sp-2)" }}>
                  <div className="skeleton" style={{ width: 48, height: 48 }} />
                  <div className="skeleton" style={{ width: 48, height: 8 }} />
                </div>
              ))}
            </div>
          </div>
        </Row>

        <div className="status-bar" style={{ width: "100%" }}>
          <span>{t("itemCount", { n: 1296 })}</span>
          <span>{t("selectedCount", { n: 8 })}</span>
          <span className="spacer" />
          <span className="badge is-ok">
            <Icon name="check" size={13} />
            {t("syncIdle", { when: formatDate("2026-09-17T17:58:00Z", lang, t, NOW) })}
          </span>
          <span className="spacer" />
          <button className="btn is-icon is-active">
            <Icon name="layoutGrid" size={15} />
          </button>
          <button className="btn is-icon">
            <Icon name="list" size={15} />
          </button>
          <input className="slider" type="range" min={32} max={256} defaultValue={64} />
        </div>
      </Section>

      {/* ---- quick jump and folder picker ------------------------------------ */}
      <Section title={s("Ctrl+K 快速跳转 / 文件夹选择器", "Quick jump and folder picker")}>
        <Row>
          <div className="menu" style={{ width: 320, padding: 0 }}>
            <div className="search-box" style={{ width: "100%", border: "none", height: 36 }}>
              <Icon name="search" size={15} />
              <input placeholder={t("quickJumpPlaceholder")} defaultValue="sat" readOnly />
            </div>
            <div className="menu-sep" style={{ margin: 0 }} />
            <div style={{ padding: "var(--sp-1)" }}>
              <button className="menu-item" style={{ background: "var(--bg-hover)" }}>
                <Icon name="folder" size={15} />
                <mark>SAT</mark>
                <span className="menu-shortcut">学习 / SAT</span>
              </button>
              {SAMPLES.slice(2, 4).map((c) => (
                <button key={c.uuid} className="menu-item">
                  <ChatIcon size={14} model={c.model} summary={c.summary} />
                  {displayName(c, lang, t)}
                </button>
              ))}
            </div>
          </div>

          <div className="menu" style={{ width: 280, padding: 0 }}>
            <div className="search-box" style={{ width: "100%", border: "none", height: 36 }}>
              <Icon name="folder" size={15} />
              <input placeholder={t("folderPickerPlaceholder")} defaultValue="xue" readOnly />
            </div>
            <div className="menu-sep" style={{ margin: 0 }} />
            <div style={{ padding: "var(--sp-1)" }}>
              {FOLDERS.filter((f) => f.id === "study" || f.id === "sat").map((f, i) => (
                <button
                  key={f.id}
                  className="menu-item"
                  style={i === 0 ? { background: "var(--bg-hover)" } : undefined}
                >
                  <Icon name="folder" size={15} />
                  {f.name}
                  <span className="menu-shortcut">{i === 0 ? "Enter" : ""}</span>
                </button>
              ))}
            </div>
          </div>
        </Row>
      </Section>

      {/* ---- settings --------------------------------------------------------- */}
      <Section title={s("设置页", "Settings")}>
        <div className="gx-panel gx-settings">
          <nav>
            {(
              [
                "settingsAppearance",
                "settingsBehaviour",
                "settingsSync",
                "settingsData",
                "settingsAbout"
              ] as const
            ).map((k, i) => (
              <div key={k} className={`tree-node${i === 0 ? " is-selected" : ""}`}>
                <span className="tree-label">{t(k)}</span>
              </div>
            ))}
          </nav>
          <div className="gx-settings-body">
            <label className="gx-field">
              <span>{t("theme")}</span>
              <select className="input">
                <option>{t("themeSystem")}</option>
                <option>{t("themeLight")}</option>
                <option>{t("themeDark")}</option>
              </select>
            </label>
            <label className="gx-field">
              <span>{t("language")}</span>
              <select className="input">
                <option>{t("languageAuto")}</option>
                <option>中文</option>
                <option>English</option>
              </select>
            </label>
            <label className="gx-field">
              <span>{t("defaultIconSize")}</span>
              <input className="slider" type="range" min={32} max={256} defaultValue={64} />
            </label>
            <label className="gx-field">
              <span>{t("hoverDelay")}</span>
              <input className="input" style={{ width: 70 }} defaultValue="3000" />
            </label>
            <label className="gx-field">
              <span>{t("previewDefault")}</span>
              <input className="switch" type="checkbox" readOnly checked />
            </label>
          </div>
        </div>
      </Section>
    </div>
  );
}

/** DESIGN 3.4: two lines collapsed, full text when selected, pencil when renamed. */
function NameCell({
  chat,
  lang,
  expanded
}: {
  chat: Chat;
  lang: Lang;
  expanded: boolean;
}) {
  const t = translator(lang);
  return (
    // The slot holds the two-line footprint in the grid; expansion happens
    // inside it, absolutely, so the icon above never moves.
    <div className="name-slot">
      <span
        className={`name-label${expanded ? " is-expanded" : ""}${
          chat.status === "missing" ? " is-missing" : ""
        }`}
      >
        {displayName(chat, lang, t)}
        {isRenamed(chat) && <Icon name="pencil" size={11} className="name-pencil" />}
      </span>
    </div>
  );
}

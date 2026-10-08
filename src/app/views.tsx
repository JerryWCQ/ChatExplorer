/**
 * The two content views. Both are dumb renderers: ordering, grouping,
 * selection and all mutations are decided in App and arrive as props, so the
 * views can never disagree with the keyboard layer about what is selected.
 *
 * Cells and rows are memoised and take only primitives plus the (stable)
 * handler bag, because selection changes constantly — a marquee drag over a
 * folder with thousands of chats would otherwise re-render every single node
 * on every frame. With memo only the handful of nodes whose own flags flipped
 * actually re-render.
 */

import {
  memo,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from "react";
import { modelInfo } from "../core/model";
import {
  COLUMN_WIDTH,
  COLUMN_WIDTH_RANGE,
  type ColumnKey,
  type Density,
  type Folder,
  type FolderView
} from "../core/schema";
import { ChatIcon, FolderIcon, ModelTag } from "../ui/ChatIcon";
import { formatDate, isRenamed } from "../ui/format";
import { Icon, SolidIcon } from "../ui/Icon";
import type { Lang, T } from "../ui/i18n";
import { folderPathLabel, type Group, type Item } from "./model";

export interface ItemHandlers {
  onItemMouseDown: (e: ReactMouseEvent, item: Item, index: number) => void;
  onItemClick: (e: ReactMouseEvent, item: Item, index: number) => void;
  onItemDoubleClick: (item: Item) => void;
  onItemContextMenu: (e: ReactMouseEvent, item: Item, index: number) => void;
  /** Explorer-style check boxes: toggle one item without disturbing the rest. */
  onItemCheck: (item: Item, index: number, checked: boolean) => void;
  onDragStart: (e: DragEvent, item: Item) => void;
  onDragEnd: () => void;
  onFolderDragOver: (e: DragEvent, item: Item) => void;
  onFolderDragLeave: (e: DragEvent, item: Item) => void;
  onFolderDrop: (e: DragEvent, item: Item) => void;
  onRenameCommit: (item: Item, value: string) => void;
  onRenameCancel: () => void;
  /** Fold ↔ unfold a pile. The only thing a stack cell does that a chat cell cannot. */
  onStackToggle: (item: Item) => void;
}

export interface ViewProps {
  groups: Group[];
  flat: Item[];
  view: FolderView;
  folders: Folder[];
  selection: Set<string>;
  cutKeys: Set<string>;
  focusKey: string | null;
  editingKey: string | null;
  /* No `dropKey` / `draggingKeys`: see cellClass. */
  /** Group ids currently collapsed in this location. */
  collapsed: Set<string>;
  /** Stack ids currently fanned open. Icon view only. */
  openStacks: Set<string>;
  onToggleGroup: (id: string) => void;
  /** Item check boxes on/off (a setting). */
  checkboxes: boolean;
  onSelectAll: (checked: boolean) => void;
  peekFor: (folderId: string) => (string | null)[];
  hand: ItemHandlers;
  t: T;
  lang: Lang;
}

/**
 * State flags a cell needs. Kept as separate props rather than an object so
 * memo's default shallow compare actually bites — an object literal would be a
 * fresh identity every render and defeat the memo entirely.
 */
interface Flags {
  cut: boolean;
  focused: boolean;
  editing: boolean;
}

function flagsFor(props: ViewProps, item: Item): Flags {
  return {
    cut: props.cutKeys.has(item.key),
    focused: props.focusKey === item.key,
    editing: props.editingKey === item.key
  };
}

/**
 * `is-selected`, `is-drop` and `is-dragging` are deliberately absent. All three
 * change during a gesture, and a gesture must not push anything through React
 * over a list this long — App and the marquee write them straight to the DOM
 * and re-apply them after any render that overwrites `className` here.
 *
 * 〔修订 2026-09-19 第三批〕`is-selected` joined that list because selection is
 * the one that changes most: with it in `className`, committing a sweep of 500
 * rows meant re-rendering 500 rows to set a class the DOM already had. Now the
 * commit is a paint, and the rows do not re-render at all.
 */
function cellClass(base: string, f: Flags): string {
  let cls = base;
  if (f.cut) cls += " is-cut";
  if (f.focused) cls += " is-focus";
  return cls;
}

function renameInitial(item: Item): string {
  return item.ref.kind === "folder"
    ? item.name
    : (item.chat?.displayName ?? item.chat?.remoteName ?? item.name);
}

function RenameInput({
  initial,
  onCommit,
  onCancel
}: {
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  return (
    <input
      className="rename-input"
      defaultValue={initial}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") onCommit(e.currentTarget.value);
        else if (e.key === "Escape") onCancel();
      }}
      onBlur={(e) => onCommit(e.currentTarget.value)}
    />
  );
}

/**
 * A check box that must not be mistaken for a click on the item: mousedown is
 * what starts selection and drags, so it is swallowed here and the change
 * event does the work instead.
 *
 * **Uncontrolled on purpose.** Its tick follows `is-selected`, and that class is
 * painted onto the DOM rather than rendered (see `cellClass`), so the tick is
 * moved the same way — by App's selection paint and by the marquee. Giving it a
 * `checked` prop would drag every row back into React on every selection change,
 * which is the whole thing this avoids.
 */
function ItemCheck({
  className,
  onToggle
}: {
  className: string;
  onToggle: (checked: boolean) => void;
}) {
  return (
    <input
      type="checkbox"
      className={`checkbox ${className}`}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onChange={(e) => onToggle(e.currentTarget.checked)}
    />
  );
}

// --- group header ------------------------------------------------------------------

function GroupHeader({
  group,
  collapsed,
  onToggle,
  t
}: {
  group: Group;
  collapsed: boolean;
  onToggle: () => void;
  t: T;
}) {
  return (
    <div className="group-header is-toggle" onClick={onToggle}>
      <Icon name={collapsed ? "chevronRight" : "chevronDown"} size={12} />
      <span>{group.label}</span>
      <span className="tree-count">{t("itemCount", { n: group.items.length })}</span>
    </div>
  );
}

// --- icon view -----------------------------------------------------------------

/**
 * The name under an icon, clamped to the slot's two lines.
 *
 * `mayExpand` is permission, not instruction: the label only actually expands
 * when the name really does not fit. A name that fits gets no overlay at all,
 * because the overlay is a different painted surface and on a short name that
 * difference is pure noise — which is what the user saw as a pale slab sitting
 * on the selected cell.
 *
 * The measurement is `scrollHeight` against the slot, which reports the full
 * text height in both the clamped and the expanded state. That symmetry is what
 * keeps it from oscillating: expanding cannot make the answer flip back.
 * Only the single sole-selected cell ever gets `mayExpand`, so this costs one
 * layout read, not 1296.
 */
function NameLabel({
  name,
  mayExpand,
  missing,
  children
}: {
  name: string;
  mayExpand: boolean;
  missing?: boolean;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    if (!mayExpand) {
      setOverflows(false);
      return;
    }
    const el = ref.current;
    const slot = el?.parentElement;
    if (!el || !slot) return;
    setOverflows(el.scrollHeight > slot.clientHeight + 1);
  }, [mayExpand, name]);

  return (
    <div
      ref={ref}
      className={`name-label${mayExpand && overflows ? " is-expanded" : ""}${
        missing ? " is-missing" : ""
      }`}
    >
      {name}
      {children}
    </div>
  );
}

/**
 * How far the fan-out stagger is allowed to count before every later member
 * shares the last slot's delay. A day with two hundred chats would otherwise
 * take five seconds to finish opening, and the last cells would animate long
 * after the user had started reading.
 */
const STAGGER_CAP = 11;

/** `--i` drives the fan-out delay; the class is what turns the animation on. */
function memberStyle(stackIndex: number | undefined): CSSProperties | undefined {
  if (stackIndex === undefined) return undefined;
  return { "--i": Math.min(stackIndex, STAGGER_CAP) } as CSSProperties;
}

const GridCell = memo(function GridCell({
  item,
  index,
  size,
  expanded,
  checkboxes,
  peek,
  hand,
  ...flags
}: {
  item: Item;
  index: number;
  size: number;
  expanded: boolean;
  checkboxes: boolean;
  peek: (string | null)[];
  hand: ItemHandlers;
} & Flags) {
  const droppable = item.ref.kind === "folder";
  return (
    <div
      data-key={item.key}
      className={cellClass(`grid-cell${item.inStack ? " is-stacked" : ""}`, flags)}
      style={memberStyle(item.stackIndex)}
      draggable={!flags.editing}
      onMouseDown={(e) => hand.onItemMouseDown(e, item, index)}
      onClick={(e) => hand.onItemClick(e, item, index)}
      onDoubleClick={() => !flags.editing && hand.onItemDoubleClick(item)}
      onContextMenu={(e) => hand.onItemContextMenu(e, item, index)}
      onDragStart={(e) => hand.onDragStart(e, item)}
      onDragEnd={hand.onDragEnd}
      onDragOver={droppable ? (e) => hand.onFolderDragOver(e, item) : undefined}
      onDragLeave={droppable ? (e) => hand.onFolderDragLeave(e, item) : undefined}
      onDrop={droppable ? (e) => hand.onFolderDrop(e, item) : undefined}
    >
      {checkboxes && (
        <ItemCheck className="cell-check" onToggle={(c) => hand.onItemCheck(item, index, c)} />
      )}
      {/* FolderIcon takes no `dropTarget`: the drop-target stroke comes from an
          ancestor `.is-drop`, painted onto the cell by App during the drag.
          Passing it as a prop would mean a render per drag-over. */}
      {item.ref.kind === "folder" ? (
        <FolderIcon size={size} peek={peek} />
      ) : (
        <ChatIcon
          size={size}
          model={item.chat?.model ?? null}
          summary={item.chat?.summary ?? ""}
          missing={item.chat?.status === "missing"}
          starred={item.chat?.isStarred}
          flagged={item.chat?.flagged}
          isShortcut={item.ref.kind === "shortcut"}
        />
      )}
      <div className="name-slot">
        {flags.editing ? (
          <RenameInput
            initial={renameInitial(item)}
            onCommit={(v) => hand.onRenameCommit(item, v)}
            onCancel={hand.onRenameCancel}
          />
        ) : (
          <NameLabel name={item.name} mayExpand={expanded} missing={item.chat?.status === "missing"}>
            {item.chat && isRenamed(item.chat) && (
              <Icon className="name-pencil" name="pencil" size={10} />
            )}
          </NameLabel>
        )}
      </div>
    </div>
  );
});

/**
 * A pile, and — when it is open — the button that stands in the pile's place.
 *
 * The whole thing is three absolutely-positioned cards under the representative
 * chat's icon. No canvas, no library, no screenshots of the members: the back
 * cards are blank paper, because at 64px a real thumbnail of the second-newest
 * chat is indistinguishable from a smudge and costs two more `ChatIcon`s per
 * pile. What reads as "several things" is the offset and the rotation.
 *
 * Open, the cell keeps its slot and its identity — same `data-key`, same
 * selection behaviour — and only its face changes, to a dashed tile with a
 * chevron. That is the user's 「原位置用一个按钮替代，然后再点就折叠回去」: the
 * members are laid out after it, and this is what folds them back.
 */
const StackCell = memo(function StackCell({
  item,
  index,
  size,
  open,
  expanded,
  checkboxes,
  hand,
  t,
  ...flags
}: {
  item: Item;
  index: number;
  size: number;
  open: boolean;
  expanded: boolean;
  checkboxes: boolean;
  hand: ItemHandlers;
  t: T;
} & Flags) {
  const info = item.stack;
  const count = info?.members.length ?? 0;
  const toggle = (e: ReactMouseEvent) => {
    e.stopPropagation();
    // Only the first click of a burst: a double-click on the button must be
    // one toggle, not open-then-shut.
    if (e.detail <= 1) hand.onStackToggle(item);
  };

  return (
    <div
      data-key={item.key}
      className={cellClass(`grid-cell is-stack${open ? " is-open" : ""}`, flags)}
      draggable={!flags.editing}
      onMouseDown={(e) => hand.onItemMouseDown(e, item, index)}
      // A single click toggles the pile (App's `onItemClick`), so there is no
      // double-click handler here: a double-click is one toggle, not three.
      // Enter still reaches `onItemDoubleClick` through the keyboard path.
      onClick={(e) => !flags.editing && hand.onItemClick(e, item, index)}
      onContextMenu={(e) => hand.onItemContextMenu(e, item, index)}
      onDragStart={(e) => hand.onDragStart(e, item)}
      onDragEnd={hand.onDragEnd}
      // A pile takes drops the way a folder does — but it files nothing, it
      // just widens its own membership. App tells the two apart by ref kind.
      onDragOver={(e) => hand.onFolderDragOver(e, item)}
      onDragLeave={(e) => hand.onFolderDragLeave(e, item)}
      onDrop={(e) => hand.onFolderDrop(e, item)}
    >
      {checkboxes && (
        <ItemCheck className="cell-check" onToggle={(c) => hand.onItemCheck(item, index, c)} />
      )}
      {open ? (
        <button
          type="button"
          className="stack-collapse"
          style={{ width: size, height: size }}
          title={t("stackCollapse")}
          aria-label={t("stackCollapse")}
          onMouseDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onClick={toggle}
        >
          <Icon name="chevronUp" size={Math.max(14, Math.round(size * 0.28))} />
        </button>
      ) : (
        <div className="stack-pile" style={{ width: size, height: size }}>
          <span className="stack-card is-back" aria-hidden="true" />
          <span className="stack-card is-mid" aria-hidden="true" />
          <span className="stack-top">
            <ChatIcon
              size={size}
              model={item.chat?.model ?? null}
              summary={item.chat?.summary ?? ""}
              starred={item.chat?.isStarred}
            />
          </span>
          <button
            type="button"
            className="stack-badge"
            title={t("stackExpand")}
            aria-label={t("stackExpand")}
            onMouseDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onClick={toggle}
          >
            {count}
          </button>
        </div>
      )}
      <div className="name-slot">
        {flags.editing ? (
          <RenameInput
            initial={info?.record?.name ?? item.name}
            onCommit={(v) => hand.onRenameCommit(item, v)}
            onCancel={hand.onRenameCancel}
          />
        ) : (
          <NameLabel name={item.name} mayExpand={expanded}>
            {open && <span className="name-date">{t("itemCount", { n: count })}</span>}
          </NameLabel>
        )}
      </div>
    </div>
  );
});

export function IconView(props: ViewProps) {
  const { groups, view, hand, t, collapsed } = props;
  const size = view.iconSize;
  const cellW = size + 24;
  const cellH = size + 58;
  // The expanded name overlaps its neighbours, so it is only legible for one
  // item at a time. With a hundred cells selected the grid turned to soup
  // (user report), hence: expand only when the selection is a single item.
  //
  // Derived as a key rather than read off each cell's `selected` flag, because
  // cells no longer have one. It is also strictly cheaper: at most two cells
  // see a changed `expanded` prop when the selection moves, so memo keeps the
  // other 1294 out of the render entirely.
  const soleKey = props.selection.size === 1 ? props.selection.values().next().value : undefined;
  let index = -1;

  return (
    <div>
      {groups.map((group) => {
        const isCollapsed = collapsed.has(group.id);
        return (
          <div key={group.id}>
            {group.label && (
              <GroupHeader
                group={group}
                collapsed={isCollapsed}
                onToggle={() => props.onToggleGroup(group.id)}
                t={t}
              />
            )}
            {!isCollapsed && (
              <div
                className="icon-grid"
                style={{ "--cell-w": `${cellW}px`, "--cell-h": `${cellH}px` } as CSSProperties}
              >
                {group.items.map((item) => {
                  index += 1;
                  return item.ref.kind === "stack" ? (
                    <StackCell
                      key={item.key}
                      item={item}
                      index={index}
                      size={size}
                      {...flagsFor(props, item)}
                      open={props.openStacks.has(item.ref.id)}
                      expanded={item.key === soleKey}
                      checkboxes={props.checkboxes}
                      hand={hand}
                      t={t}
                    />
                  ) : (
                    <GridCell
                      key={item.key}
                      item={item}
                      index={index}
                      size={size}
                      {...flagsFor(props, item)}
                      expanded={item.key === soleKey}
                      checkboxes={props.checkboxes}
                      peek={item.ref.kind === "folder" ? props.peekFor(item.ref.id) : NO_PEEK}
                      hand={hand}
                    />
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Shared so a chat cell's `peek` prop keeps a stable identity under memo. */
const NO_PEEK: (string | null)[] = [];

// --- details view ---------------------------------------------------------------

/** Width of the leading check-box column when item check boxes are on. */
const CHECK_WIDTH = 28;

/**
 * Column widths travel as CSS custom properties on the `.details-view` root,
 * never as inline pixel values on the cells.
 *
 * That is the whole reason a resize drag is cheap: dragging writes **one**
 * property on **one** element and the browser relayouts, while a per-cell
 * inline width would mean re-rendering 1296 rows × 4 columns per frame. It
 * also keeps `DetailsRow`'s memo intact — `var(--col-model)` is the same
 * string on every render, so the style object never looks "changed" in a way
 * that matters.
 */
function colStyle(col: ColumnKey): CSSProperties {
  return col === "name"
    ? { flex: 1, minWidth: 0 }
    : { width: `var(--col-${col})`, flex: "none" };
}

/** The custom properties themselves: defaults, with the user's drags on top. */
function colVars(view: FolderView): CSSProperties {
  const vars: Record<string, string> = {};
  for (const col of view.columns) {
    if (col === "name") continue;
    const w = view.columnWidths?.[col] ?? COLUMN_WIDTH[col];
    vars[`--col-${col}`] = `${w}px`;
  }
  return vars as CSSProperties;
}

function clampWidth(px: number): number {
  return Math.round(Math.min(COLUMN_WIDTH_RANGE.max, Math.max(COLUMN_WIDTH_RANGE.min, px)));
}

function colLabel(col: ColumnKey, t: T): string {
  switch (col) {
    case "name":
      return t("colName");
    case "updatedAt":
      return t("colUpdated");
    case "createdAt":
      return t("colCreated");
    case "location":
      return t("colLocation");
    case "model":
      return t("colModel");
    case "starred":
      return t("colStarred");
  }
}

const COL_SORT: Partial<Record<ColumnKey, FolderView["sortKey"]>> = {
  name: "name",
  updatedAt: "updatedAt",
  createdAt: "createdAt",
  model: "model",
  location: "location"
};

const DetailsRow = memo(function DetailsRow({
  item,
  index,
  columns,
  density,
  checkboxes,
  locationLabel,
  hand,
  t,
  lang,
  ...flags
}: {
  item: Item;
  index: number;
  columns: ColumnKey[];
  density: Density;
  checkboxes: boolean;
  locationLabel: string;
  hand: ItemHandlers;
  t: T;
  lang: Lang;
} & Flags) {
  const droppable = item.ref.kind === "folder";

  const cellFor = (col: ColumnKey) => {
    const style = colStyle(col);
    if (col === "name") {
      return (
        <div key={col} style={style}>
          <span className="row-icon">
            {item.ref.kind === "folder" ? (
              <Icon name="folder" size={15} />
            ) : item.ref.kind === "shortcut" ? (
              <Icon name="cornerUpRight" size={14} />
            ) : (
              <Icon name="fileText" size={15} />
            )}
          </span>
          {flags.editing ? (
            <RenameInput
              initial={renameInitial(item)}
              onCommit={(v) => hand.onRenameCommit(item, v)}
              onCancel={hand.onRenameCancel}
            />
          ) : density === "comfortable" && item.chat ? (
            <span className="row-stack">
              <span className="row-name">
                {item.name}
                {isRenamed(item.chat) && <Icon className="name-pencil" name="pencil" size={10} />}
              </span>
              <span className="row-secondary">{item.chat.summary.trim() || t("noSummary")}</span>
            </span>
          ) : (
            <span className="row-name">
              {item.name}
              {item.chat && isRenamed(item.chat) && (
                <Icon className="name-pencil" name="pencil" size={10} />
              )}
            </span>
          )}
          {item.chat?.flagged && <SolidIcon name="bookmark" size={12} className="mark-flag" />}
        </div>
      );
    }
    if (!item.chat) return <div key={col} style={style} />;
    switch (col) {
      case "updatedAt":
        return (
          <div key={col} style={style} className="row-secondary">
            {formatDate(item.chat.updatedAt, lang, t)}
          </div>
        );
      case "createdAt":
        return (
          <div key={col} style={style} className="row-secondary">
            {formatDate(item.chat.createdAt, lang, t)}
          </div>
        );
      case "model":
        return (
          <div key={col} style={style}>
            <ModelTag info={modelInfo(item.chat.model)} />
          </div>
        );
      case "location":
        return (
          <div key={col} style={style} className="row-secondary">
            {locationLabel}
          </div>
        );
      case "starred":
        return (
          <div key={col} style={style}>
            {item.chat.isStarred && <SolidIcon name="star" size={12} />}
          </div>
        );
    }
  };

  return (
    <div
      data-key={item.key}
      className={cellClass(
        `details-row is-${density}${item.chat?.status === "missing" ? " is-missing" : ""}`,
        flags
      )}
      draggable={!flags.editing}
      onMouseDown={(e) => hand.onItemMouseDown(e, item, index)}
      onClick={(e) => hand.onItemClick(e, item, index)}
      onDoubleClick={() => !flags.editing && hand.onItemDoubleClick(item)}
      onContextMenu={(e) => hand.onItemContextMenu(e, item, index)}
      onDragStart={(e) => hand.onDragStart(e, item)}
      onDragEnd={hand.onDragEnd}
      onDragOver={droppable ? (e) => hand.onFolderDragOver(e, item) : undefined}
      onDragLeave={droppable ? (e) => hand.onFolderDragLeave(e, item) : undefined}
      onDrop={droppable ? (e) => hand.onFolderDrop(e, item) : undefined}
    >
      {checkboxes && (
        <div className="row-check" style={{ width: CHECK_WIDTH, flex: "none" }}>
          <ItemCheck className="" onToggle={(c) => hand.onItemCheck(item, index, c)} />
        </div>
      )}
      {columns.map(cellFor)}
    </div>
  );
});

export function DetailsView(
  props: ViewProps & {
    onSortBy: (key: FolderView["sortKey"]) => void;
    onColumnResize: (col: Exclude<ColumnKey, "name">, width: number) => void;
  }
) {
  const { groups, view, folders, hand, t, lang, collapsed } = props;
  const density = view.density;
  let index = -1;

  // The element the custom properties live on. A resize drag writes straight
  // to it and never touches React until the pointer comes back up.
  const rootRef = useRef<HTMLDivElement>(null);
  /**
   * A drag that ends inside a header cell still produces a `click` on that
   * cell, which would sort the list the user was only trying to widen. The
   * grip can't stop that by itself — the click's target is the common ancestor
   * of press and release, i.e. the header cell, not the grip — so the grip
   * raises this flag and the header's own handler consumes it.
   */
  const dragged = useRef(false);

  const startResize = (e: ReactPointerEvent, col: Exclude<ColumnKey, "name">) => {
    if (e.button !== 0) return;
    const root = rootRef.current;
    if (!root) return;
    e.preventDefault();
    e.stopPropagation();
    const grip = e.currentTarget as HTMLElement;
    grip.setPointerCapture(e.pointerId);

    const startX = e.clientX;
    const start = view.columnWidths?.[col] ?? COLUMN_WIDTH[col];
    let width = start;
    let raf = 0;

    const paint = () => {
      raf = 0;
      root.style.setProperty(`--col-${col}`, `${width}px`);
    };
    const move = (ev: PointerEvent) => {
      const next = clampWidth(start + (ev.clientX - startX));
      if (next === width) return;
      width = next;
      dragged.current = true;
      // One paint per frame: pointermove fires far faster than the compositor.
      if (raf === 0) raf = requestAnimationFrame(paint);
    };
    const end = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", end);
      grip.removeEventListener("pointercancel", end);
      if (raf !== 0) cancelAnimationFrame(raf);
      root.style.setProperty(`--col-${col}`, `${width}px`);
      // React learns the width exactly once, at the end of the gesture.
      if (width !== start) props.onColumnResize(col, width);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
  };

  // Path labels repeat heavily (a folder view is one path for every row), and
  // folderPathLabel walks the tree, so memoise within the render pass.
  const pathCache = new Map<string, string>();
  const locationLabel = (folderId: string | undefined) => {
    if (!folderId) return "";
    let hit = pathCache.get(folderId);
    if (hit === undefined) {
      hit = folderPathLabel(folders, folderId, t);
      pathCache.set(folderId, hit);
    }
    return hit;
  };

  const allChecked = props.flat.length > 0 && props.flat.every((i) => props.selection.has(i.key));
  const someChecked = props.selection.size > 0 && !allChecked;

  return (
    <div className="details-view" ref={rootRef} style={colVars(view)}>
      <div className="details-header">
        {props.checkboxes && (
          <div className="row-check" style={{ width: CHECK_WIDTH, flex: "none" }}>
            <input
              type="checkbox"
              className="checkbox"
              checked={allChecked}
              ref={(el) => {
                if (el) el.indeterminate = someChecked;
              }}
              onChange={(e) => props.onSelectAll(e.currentTarget.checked)}
            />
          </div>
        )}
        {view.columns.map((col) => {
          const sortKey = COL_SORT[col];
          const active = sortKey !== undefined && view.sortKey === sortKey;
          return (
            <div
              key={col}
              style={colStyle(col)}
              onClick={() => {
                // Swallow the click that ends a resize drag — see `dragged`.
                if (dragged.current) {
                  dragged.current = false;
                  return;
                }
                if (sortKey !== undefined) props.onSortBy(sortKey);
              }}
            >
              <span>{colLabel(col, t)}</span>
              {active && <Icon name={view.sortAsc ? "chevronUp" : "chevronDown"} size={12} />}
              {/* No visual affordance, per 「不需要ui提示」 — only the cursor
                  changes. The grip belongs to the column it widens, so the
                  name column (which just takes the slack) has none. */}
              {col !== "name" && (
                <span
                  className="col-resize"
                  onPointerDown={(e) => startResize(e, col)}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    props.onColumnResize(col, COLUMN_WIDTH[col]);
                  }}
                />
              )}
            </div>
          );
        })}
      </div>

      {groups.map((group) => {
        const isCollapsed = collapsed.has(group.id);
        return (
          <div key={group.id}>
            {group.label && (
              <GroupHeader
                group={group}
                collapsed={isCollapsed}
                onToggle={() => props.onToggleGroup(group.id)}
                t={t}
              />
            )}
            {!isCollapsed &&
              group.items.map((item) => {
                index += 1;
                return (
                  <DetailsRow
                    key={item.key}
                    item={item}
                    index={index}
                    columns={view.columns}
                    density={density}
                    {...flagsFor(props, item)}
                    checkboxes={props.checkboxes}
                    locationLabel={locationLabel(item.chat?.folderId)}
                    hand={hand}
                    t={t}
                    lang={lang}
                  />
                );
              })}
          </div>
        );
      })}
    </div>
  );
}

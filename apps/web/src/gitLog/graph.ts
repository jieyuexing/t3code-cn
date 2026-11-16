// 提交分支图的泳道算法（纯函数）：输入按显示顺序（子提交在前，--topo-order）排好的提交，
// 输出每行的节点泳道与上下连线。状态可以接着往下画，分页加载不重算已画的行。

export interface GraphCommit {
  id: string;
  parents: string[];
}

/** 一条泳道上的线：lane 是泳道序号，color 是颜色序号（视图按调色板长度取模循环）。 */
export interface GraphEdge {
  lane: number;
  color: number;
}

export interface GraphRow {
  id: string;
  /** 节点所在泳道。 */
  lane: number;
  color: number;
  /** 多于一个父提交。 */
  merge: boolean;
  /** 上半格有线进入节点（该提交已被某条泳道等着）。 */
  up: boolean;
  /** 下半格有线离开节点（有第一父提交）。 */
  down: boolean;
  /** 整格竖线：与本提交无关、只是路过的泳道。 */
  through: GraphEdge[];
  /** 上半格：别的泳道汇入节点（lane 为来源泳道）。 */
  ins: GraphEdge[];
  /** 下半格：节点分出到别的泳道（lane 为目标泳道），第二及以后的父提交。 */
  outs: GraphEdge[];
  /** 本行占用的泳道数（最大序号 + 1）。 */
  lanes: number;
}

interface Slot {
  id: string;
  color: number;
}

export interface GraphState {
  /** 每条泳道正在等的提交；null 为空闲，末尾的空闲泳道会被裁掉。 */
  slots: Array<Slot | null>;
  nextColor: number;
  /** 已画各行的最大泳道数，决定列宽。 */
  maxLanes: number;
}

export const startGraph = (): GraphState => ({ slots: [], nextColor: 0, maxLanes: 0 });

/** 接着 state 往下画 commits，返回新增的行和新状态；传入的 state 不会被改动。 */
export function drawGraph(
  state: GraphState,
  commits: readonly GraphCommit[],
): { rows: GraphRow[]; state: GraphState } {
  const slots = [...state.slots];
  let nextColor = state.nextColor;
  let maxLanes = state.maxLanes;
  const free = () => {
    const index = slots.indexOf(null);
    return index < 0 ? slots.length : index;
  };
  const rows: GraphRow[] = [];
  for (const commit of commits) {
    const waiting = slots.flatMap((slot, index) => (slot?.id === commit.id ? [index] : []));
    const up = waiting.length > 0;
    const lane = waiting[0] ?? free();
    const color = up ? slots[lane]!.color : nextColor++;
    const through = slots.flatMap((slot, index) =>
      slot && !waiting.includes(index) ? [{ lane: index, color: slot.color }] : [],
    );
    const ins = waiting.slice(1).map((index) => ({ lane: index, color: slots[index]!.color }));
    for (const index of waiting) slots[index] = null;

    const [first, ...others] = commit.parents;
    if (first !== undefined) slots[lane] = { id: first, color };
    const outs: GraphEdge[] = [];
    for (const parent of others) {
      let target = slots.findIndex((slot) => slot?.id === parent);
      if (target < 0) {
        target = free();
        slots[target] = { id: parent, color: nextColor++ };
      }
      outs.push({ lane: target, color: slots[target]!.color });
    }
    while (slots.length > 0 && slots[slots.length - 1] === null) slots.pop();

    const lanes =
      Math.max(
        lane,
        ...through.map((edge) => edge.lane),
        ...ins.map((edge) => edge.lane),
        ...outs.map((edge) => edge.lane),
      ) + 1;
    maxLanes = Math.max(maxLanes, lanes);
    rows.push({
      id: commit.id,
      lane,
      color,
      merge: commit.parents.length > 1,
      up,
      down: first !== undefined,
      through,
      ins,
      outs,
      lanes,
    });
  }
  return { rows, state: { slots, nextColor, maxLanes } };
}

export const ROW_HEIGHT = 22;
export const LANE_WIDTH = 10;
/** 最多画这么多条泳道；再多的折叠成最右一格的省略号。 */
export const GRAPH_MAX_LANES = 8;
export const PALETTE_SIZE = 6;

/** 分支图列：随泳道数变宽，超过上限后固定为“上限条泳道 + 一格省略号”。 */
export function graphColumn(maxLanes: number) {
  const truncated = maxLanes > GRAPH_MAX_LANES;
  const cells = truncated ? GRAPH_MAX_LANES + 1 : maxLanes;
  return { cells, width: cells * LANE_WIDTH, truncated };
}

export interface RowShapes {
  /** SVG path 的 d 与颜色序号。 */
  lines: Array<{ d: string; color: number }>;
  node: { x: number; y: number; color: number; merge: boolean } | null;
  /** 本行有泳道落在上限之外，没有画出来。 */
  ellipsis: boolean;
}

const cx = (lane: number) => lane * LANE_WIDTH + LANE_WIDTH / 2;
const MID = ROW_HEIGHT / 2;

/** 一行的几何：竖线、汇入与分出的曲线、节点；落在上限之外的泳道不画，改记省略号。 */
export function rowShapes(row: GraphRow): RowShapes {
  const lines: RowShapes["lines"] = [];
  let ellipsis = false;
  const visible = (lane: number) => (lane < GRAPH_MAX_LANES ? true : ((ellipsis = true), false));
  for (const edge of row.through)
    if (visible(edge.lane))
      lines.push({ d: `M${cx(edge.lane)} 0V${ROW_HEIGHT}`, color: edge.color });
  const here = visible(row.lane);
  if (here && row.up) lines.push({ d: `M${cx(row.lane)} 0V${MID}`, color: row.color });
  if (here && row.down)
    lines.push({ d: `M${cx(row.lane)} ${MID}V${ROW_HEIGHT}`, color: row.color });
  for (const edge of row.ins)
    if (visible(edge.lane) && here)
      lines.push({
        d: `M${cx(edge.lane)} 0C${cx(edge.lane)} 6 ${cx(row.lane)} 5 ${cx(row.lane)} ${MID}`,
        color: edge.color,
      });
  for (const edge of row.outs)
    if (visible(edge.lane) && here)
      lines.push({
        d: `M${cx(row.lane)} ${MID}C${cx(row.lane)} 17 ${cx(edge.lane)} 16 ${cx(edge.lane)} ${ROW_HEIGHT}`,
        color: edge.color,
      });
  return {
    lines,
    node: here ? { x: cx(row.lane), y: MID, color: row.color, merge: row.merge } : null,
    ellipsis,
  };
}

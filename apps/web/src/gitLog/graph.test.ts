import { describe, expect, test } from "vite-plus/test";
import {
  GRAPH_MAX_LANES,
  LANE_WIDTH,
  drawGraph,
  graphColumn,
  rowShapes,
  startGraph,
  type GraphCommit,
  type GraphRow,
} from "./graph";

const c = (id: string, ...parents: string[]): GraphCommit => ({ id, parents });
type Rows = [GraphRow, GraphRow, GraphRow, GraphRow, GraphRow, GraphRow, GraphRow];
const draw = (commits: GraphCommit[]) => {
  const { rows, state } = drawGraph(startGraph(), commits);
  return { rows: rows as Rows, state };
};
const lanes = (list: Array<{ lane: number }>) => list.map((edge) => edge.lane);

describe("泳道算法", () => {
  test("线性历史：全在第 0 泳道，只有上下连线", () => {
    const { rows, state } = draw([c("a", "b"), c("b", "c"), c("c")]);
    expect(rows.map((row) => [row.lane, row.up, row.down])).toEqual([
      [0, false, true],
      [0, true, true],
      [0, true, false],
    ]);
    expect(rows.every((row) => row.through.length + row.ins.length + row.outs.length === 0)).toBe(
      true,
    );
    expect(state.maxLanes).toBe(1);
    expect(state.slots).toEqual([]);
  });

  test("单次分叉合并：第二父提交另开泳道，分叉点汇合", () => {
    // m 合并 a 与 b，二者都从 r 分出。
    const { rows, state } = draw([c("m", "a", "b"), c("a", "r"), c("b", "r"), c("r")]);
    const [m, a, b, r] = rows;
    expect([m.lane, m.merge, m.up, m.down, lanes(m.outs)]).toEqual([0, true, false, true, [1]]);
    expect([a.lane, a.up, a.down, lanes(a.through)]).toEqual([0, true, true, [1]]);
    expect([b.lane, b.up, b.down, lanes(b.through)]).toEqual([1, true, true, [0]]);
    expect([r.lane, r.up, r.down, lanes(r.ins)]).toEqual([0, true, false, [1]]);
    expect(m.outs[0]?.color).toBe(b.color);
    expect(m.color).not.toBe(b.color);
    expect(state.maxLanes).toBe(2);
    expect(state.slots).toEqual([]);
  });

  test("交叉合并：第二父提交已有泳道时不新开，连线越过中间泳道", () => {
    // m1 把 q 放到第 1 泳道；m2 是新分支顶端，它的第二父提交 r 已在第 0 泳道。
    const { rows } = draw([c("m1", "p", "q"), c("p", "r"), c("m2", "q", "r"), c("q"), c("r")]);
    const [, , m2, q, r] = rows;
    expect(m2.lane).toBe(2);
    expect(lanes(m2.through)).toEqual([0, 1]);
    expect(lanes(m2.outs)).toEqual([0]);
    expect(m2.outs[0]?.color).toBe(rows[1].color);
    // q 同时在第 1、2 泳道上等着：汇合到第 1 泳道。
    expect([q.lane, lanes(q.ins), lanes(q.through)]).toEqual([1, [2], [0]]);
    expect([r.lane, r.up]).toEqual([0, true]);
    expect(Math.max(...rows.map((row) => row.lanes))).toBe(3);
  });

  test("章鱼合并：三个父提交占三条泳道，再汇回同一个祖先", () => {
    const { rows, state } = draw([
      c("o", "a", "b", "c"),
      c("a", "r"),
      c("b", "r"),
      c("c", "r"),
      c("r"),
    ]);
    const [o, a, b, cc, r] = rows;
    expect(o.merge).toBe(true);
    expect(lanes(o.outs)).toEqual([1, 2]);
    expect(new Set([o.color, ...o.outs.map((edge) => edge.color)]).size).toBe(3);
    expect([a.lane, b.lane, cc.lane]).toEqual([0, 1, 2]);
    expect([r.lane, lanes(r.ins)]).toEqual([0, [1, 2]]);
    expect(state.maxLanes).toBe(3);
    expect(state.slots).toEqual([]);
  });

  test("泳道腾空后被后来的分支顶端复用", () => {
    // x 的第二父提交 b 在第 1 泳道结束后，y 作为新顶端占用第 1 泳道。
    const { rows } = draw([c("x", "a", "b"), c("b"), c("y", "a"), c("a")]);
    expect(rows[1].lane).toBe(1);
    expect(rows[2].lane).toBe(1);
    expect(rows[2].up).toBe(false);
  });

  test("分页续画：状态接着往下，与一次画完逐行相同，不改旧状态", () => {
    const commits = [c("m", "a", "b"), c("a", "r"), c("b", "r"), c("r", "s"), c("s")];
    const whole = draw(commits).rows;
    const first = draw(commits.slice(0, 2));
    const frozen = JSON.stringify(first.state);
    const second = drawGraph(first.state, commits.slice(2));
    expect(JSON.stringify(first.state)).toBe(frozen);
    expect([...first.rows, ...second.rows]).toEqual(whole);
    expect(second.rows).toHaveLength(3);
    expect(second.state.maxLanes).toBe(2);
  });
});

describe("宽度与折叠", () => {
  test("宽度随泳道数变化", () => {
    expect(graphColumn(1)).toEqual({ cells: 1, width: LANE_WIDTH, truncated: false });
    expect(graphColumn(3)).toEqual({ cells: 3, width: 3 * LANE_WIDTH, truncated: false });
    expect(graphColumn(0).width).toBe(0);
  });

  test("超过上限：只画上限条，另加一格放省略号", () => {
    expect(GRAPH_MAX_LANES).toBe(8);
    expect(graphColumn(8).truncated).toBe(false);
    expect(graphColumn(9)).toEqual({ cells: 9, width: 9 * LANE_WIDTH, truncated: true });
    expect(graphColumn(40).width).toBe(9 * LANE_WIDTH);
  });

  test("几何：上限之内正常连线，越过上限的画省略号", () => {
    const { rows } = draw([c("m", "a", "b"), c("a", "r"), c("b", "r"), c("r")]);
    const [m] = rows;
    const shapes = rowShapes(m);
    expect(shapes.node).toEqual({ x: LANE_WIDTH / 2, y: 11, color: m.color, merge: true });
    expect(shapes.lines).toHaveLength(2);
    expect(shapes.ellipsis).toBe(false);

    const wide = draw([c("t", ...Array.from({ length: 10 }, (_, index) => `p${index}`))]).rows[0];
    const cut = rowShapes(wide);
    expect(cut.ellipsis).toBe(true);
    expect(cut.lines).toHaveLength(1 + (GRAPH_MAX_LANES - 1));
  });
});

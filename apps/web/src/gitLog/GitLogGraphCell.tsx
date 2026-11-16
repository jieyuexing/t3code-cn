import { PALETTE_SIZE, ROW_HEIGHT, rowShapes, type GraphRow } from "./graph";

const PALETTE = [
  "var(--primary)",
  "var(--info)",
  "var(--success)",
  "var(--warning)",
  "var(--destructive)",
  "color-mix(in srgb, var(--info) 55%, var(--destructive))",
];
const stroke = (color: number) => PALETTE[color % PALETTE_SIZE];

/** One row's slice of the branch graph; as tall as the row so neighbouring rows' lines meet. */
export function GitLogGraphCell({ row, width }: { row: GraphRow; width: number }) {
  const { lines, node, ellipsis } = rowShapes(row);
  return (
    <svg
      className="block overflow-visible"
      width={width}
      height={ROW_HEIGHT}
      viewBox={`0 0 ${width} ${ROW_HEIGHT}`}
      aria-hidden="true"
    >
      {lines.map((line) => (
        <path key={line.d} d={line.d} stroke={stroke(line.color)} strokeWidth={1.5} fill="none" />
      ))}
      {node ? (
        <circle
          cx={node.x}
          cy={node.y}
          r={3.5}
          stroke={stroke(node.color)}
          strokeWidth={1.5}
          fill={node.merge ? "var(--background)" : stroke(node.color)}
        />
      ) : null}
      {ellipsis
        ? [-3, 0, 3].map((shift) => (
            <circle
              key={shift}
              cx={width - 5 + shift}
              cy={ROW_HEIGHT / 2}
              r={1}
              fill="var(--muted-foreground)"
            />
          ))
        : null}
    </svg>
  );
}

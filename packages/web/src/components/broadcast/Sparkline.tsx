import {sparkPath} from "@/lib/sparkline";

type Props = {
  values: number[];
  w?: number;
  h?: number;
  color?: string;
  strokeWidth?: number;
  fill?: string | null;
};

export function Sparkline({values, w = 80, h = 24, color = "currentColor", strokeWidth = 1.5, fill = null}: Props) {
  const path = sparkPath(values, w, h);
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{display: "block", overflow: "visible"}}>
      {fill && <path d={`${path} L ${w - 2} ${h - 2} L 2 ${h - 2} Z`} fill={fill} />}
      <path d={path} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

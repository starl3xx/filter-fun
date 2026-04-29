import {fmtAgo} from "@/lib/format";
import {type FeedItem, type FeedType} from "@/lib/seed";
import {C, F} from "@/lib/tokens";

const ICON_MAP: Record<FeedType, string> = {
  enter: "🚀",
  risk: "🔻",
  pump: "📈",
  whale: "🐋",
  mission: "🎯",
  launch: "✨",
  cross: "⚠️",
  lead: "👑",
};

const COLOR_MAP: Record<FeedType, string> = {
  enter: C.cyan,
  risk: C.red,
  pump: C.green,
  whale: C.yellow,
  mission: C.pink,
  launch: C.purple,
  cross: C.red,
  lead: C.yellow,
};

export function ActivityFeed({feed}: {feed: FeedItem[]}) {
  return (
    <section
      aria-label="Activity feed"
      style={{
        borderRadius: 14,
        background: "rgba(255,255,255,0.03)",
        border: `1px solid ${C.line}`,
        backdropFilter: "blur(8px)",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "12px 16px",
          borderBottom: `1px solid ${C.line}`,
          background: "rgba(255,255,255,0.03)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{display: "flex", alignItems: "center", gap: 8}}>
          <span aria-hidden style={{fontSize: 16}}>
            📡
          </span>
          <h2 style={{margin: 0, fontWeight: 800, fontSize: 13, letterSpacing: "-0.01em", fontFamily: F.display}}>
            Battle log
          </h2>
        </div>
        <span
          style={{
            fontSize: 9,
            fontFamily: F.mono,
            color: C.green,
            display: "flex",
            alignItems: "center",
            gap: 5,
            fontWeight: 800,
            letterSpacing: "0.1em",
          }}
        >
          <span style={{width: 6, height: 6, borderRadius: 99, background: C.green, boxShadow: `0 0 8px ${C.green}`}} />
          LIVE
        </span>
      </div>
      <div
        className="ff-scroll"
        aria-live="polite"
        style={{flex: 1, overflow: "auto", padding: 10, display: "flex", flexDirection: "column", gap: 6}}
      >
        {feed.map((it, idx) => {
          const c = COLOR_MAP[it.type] ?? C.text;
          return (
            <div
              key={it.id}
              className={idx === 0 ? "ff-drop" : undefined}
              style={{
                padding: "8px 10px",
                borderRadius: 10,
                background: idx === 0 ? `${c}1a` : "rgba(255,255,255,0.03)",
                border: `1px solid ${idx === 0 ? c + "44" : C.line}`,
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <div
                aria-hidden
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 7,
                  flexShrink: 0,
                  background: `${c}33`,
                  display: "grid",
                  placeItems: "center",
                  fontSize: 13,
                }}
              >
                {ICON_MAP[it.type] ?? "✦"}
              </div>
              <div style={{flex: 1, fontSize: 12, color: C.text, lineHeight: 1.4, minWidth: 0}}>{it.text}</div>
              <div style={{fontSize: 9, fontFamily: F.mono, color: C.faint}}>{fmtAgo(it.ago)}</div>
            </div>
          );
        })}
      </div>
      <div
        style={{
          padding: "10px 16px",
          borderTop: `1px solid ${C.line}`,
          fontSize: 11,
          fontFamily: F.mono,
          textAlign: "center",
          background: `linear-gradient(90deg, ${C.purple}1a, ${C.pink}1a)`,
          color: C.text,
          fontWeight: 700,
          letterSpacing: "0.04em",
        }}
      >
        “Most get filtered. One gets funded. 🔻”
      </div>
    </section>
  );
}

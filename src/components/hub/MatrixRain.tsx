import { useEffect, useRef } from "react";

const CHARS =
  "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉ0123456789ｦﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝABCDEF";

/** Slower trail = calmer to watch; advance rain on a timer instead of every display frame. */
const FADE = "rgba(0, 8, 2, 0.045)";
const TICK_MS = 110;
const RESET_CHANCE = 0.992;

/**
 * Full-viewport canvas “digital rain” (Matrix-style). Sits behind UI; keep content in a higher z-index layer.
 */
export function MatrixRain() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const fontSize = 15;
    let columns = 0;
    let drops: number[] = [];
    let lastTick = 0;

    const init = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      canvas.width = w;
      canvas.height = h;
      columns = Math.max(1, Math.floor(w / fontSize));
      drops = Array.from({ length: columns }, () => Math.floor(Math.random() * -50));
      lastTick = performance.now();
    };

    init();
    window.addEventListener("resize", init);

    let raf = 0;
    const draw = (now: number) => {
      ctx.fillStyle = FADE;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.font = `${fontSize}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`;
      ctx.textBaseline = "top";

      const tick = now - lastTick >= TICK_MS;
      if (tick) {
        lastTick = now;
      }

      for (let i = 0; i < drops.length; i++) {
        const ch = CHARS[Math.floor(Math.random() * CHARS.length)]!;
        const x = i * fontSize;
        const y = drops[i]! * fontSize;
        const head = Math.random() > 0.97;
        ctx.fillStyle = head ? "#d8ffd8" : "#00aa2b";
        ctx.fillText(ch, x, y);
        if (!tick) continue;
        if (y > canvas.height && Math.random() > RESET_CHANCE) {
          drops[i] = 0;
        } else {
          drops[i]! += 1;
        }
      }

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", init);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none fixed inset-0 z-0 h-full w-full bg-[#000805]"
      aria-hidden
    />
  );
}

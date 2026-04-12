import { useEffect, useRef } from "react";

const CHARS =
  "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉ0123456789ｦﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝABCDEF";

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

    const init = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      canvas.width = w;
      canvas.height = h;
      columns = Math.max(1, Math.floor(w / fontSize));
      drops = Array.from({ length: columns }, () => Math.floor(Math.random() * -40));
    };

    init();
    window.addEventListener("resize", init);

    let raf = 0;
    const draw = () => {
      ctx.fillStyle = "rgba(0, 8, 2, 0.09)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.font = `${fontSize}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`;
      ctx.textBaseline = "top";

      for (let i = 0; i < drops.length; i++) {
        const ch = CHARS[Math.floor(Math.random() * CHARS.length)]!;
        const x = i * fontSize;
        const y = drops[i]! * fontSize;
        const head = Math.random() > 0.96;
        ctx.fillStyle = head ? "#e8ffe8" : "#00cc33";
        ctx.fillText(ch, x, y);
        if (y > canvas.height && Math.random() > 0.98) {
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

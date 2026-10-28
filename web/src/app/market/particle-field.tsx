"use client";

import { useEffect, useRef } from "react";

// Brand ink and sea, as RGB so alpha can follow distance.
const INK = "23,52,81", SEA = "24,127,124", SUN = "245,213,72";
const LINK = 125, REACH = 170, MAX_SPEED = 1.1, CRUISE = .4;

type Dot = { x: number; y: number; vx: number; vy: number; r: number; sea: boolean };

/**
 * A constellation behind the city: dots drift and bounce off the edges, link up when close (the nearer, the
 * clearer the line), and lean toward the pointer while linking to it. Everything inside `quiet` is drawn faintly
 * so the title stays readable. Still when `running` is off or the viewer prefers reduced motion.
 */
export function ParticleField({ running, quiet }: { running: boolean; quiet: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = canvas.current;
    const host = el?.parentElement;
    const ctx = el?.getContext("2d");
    if (!el || !host || !ctx) return;
    const still = !running || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const pointer = { x: 0, y: 0, on: false };
    let dots: Dot[] = [];
    let width = 0, height = 0, frame = 0, visible = true;
    let calm = { x0: 0, y0: 0, x1: 0, y1: 0 };
    const spawn = (): Dot => {
      const angle = Math.random() * Math.PI * 2, speed = .15 + Math.random() * .3;
      return { x: Math.random() * width, y: Math.random() * height, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, r: 1.3 + Math.random() * 1.4, sea: Math.random() < .3 };
    };
    const fade = (x: number, y: number) => x > calm.x0 && x < calm.x1 && y > calm.y0 && y < calm.y1 ? .18 : 1;

    function resize() {
      const rect = host!.getBoundingClientRect();
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      width = rect.width; height = rect.height;
      el!.width = Math.round(width * ratio); el!.height = Math.round(height * ratio);
      el!.style.width = `${width}px`; el!.style.height = `${height}px`;
      ctx!.setTransform(ratio, 0, 0, ratio, 0, 0);
      const title = host!.querySelector(quiet)?.getBoundingClientRect();
      if (title) calm = { x0: title.left - rect.left - 20, y0: title.top - rect.top - 16, x1: title.right - rect.left + 20, y1: title.bottom - rect.top + 16 };
      const count = Math.round(Math.min(80, Math.max(30, width * height / 20000)));
      dots = dots.filter((d) => d.x <= width && d.y <= height).slice(0, count);
      while (dots.length < count) dots.push(spawn());
      draw();
    }

    function draw() {
      ctx!.clearRect(0, 0, width, height);
      ctx!.lineWidth = 1;
      for (let i = 0; i < dots.length; i++) {
        const a = dots[i];
        for (let j = i + 1; j < dots.length; j++) {
          const b = dots[j], dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy;
          if (d2 > LINK * LINK) continue;
          const alpha = (1 - Math.sqrt(d2) / LINK) * .24 * fade((a.x + b.x) / 2, (a.y + b.y) / 2);
          ctx!.strokeStyle = `rgba(${INK},${alpha})`;
          ctx!.beginPath(); ctx!.moveTo(a.x, a.y); ctx!.lineTo(b.x, b.y); ctx!.stroke();
        }
      }
      if (pointer.on && !still) {
        const glow = ctx!.createRadialGradient(pointer.x, pointer.y, 0, pointer.x, pointer.y, 70);
        glow.addColorStop(0, `rgba(${SUN},.28)`); glow.addColorStop(1, `rgba(${SUN},0)`);
        ctx!.fillStyle = glow;
        ctx!.beginPath(); ctx!.arc(pointer.x, pointer.y, 70, 0, Math.PI * 2); ctx!.fill();
        ctx!.lineWidth = 1.2;
        for (const d of dots) {
          const dist = Math.hypot(d.x - pointer.x, d.y - pointer.y);
          if (dist > REACH) continue;
          ctx!.strokeStyle = `rgba(${SEA},${(1 - dist / REACH) * .55 * fade(d.x, d.y)})`;
          ctx!.beginPath(); ctx!.moveTo(d.x, d.y); ctx!.lineTo(pointer.x, pointer.y); ctx!.stroke();
        }
      }
      for (const d of dots) {
        ctx!.fillStyle = `rgba(${d.sea ? SEA : INK},${.5 * fade(d.x, d.y)})`;
        ctx!.beginPath(); ctx!.arc(d.x, d.y, d.r, 0, Math.PI * 2); ctx!.fill();
      }
    }

    function step() {
      for (const d of dots) {
        if (pointer.on) {
          const dx = pointer.x - d.x, dy = pointer.y - d.y, dist = Math.hypot(dx, dy);
          if (dist < REACH && dist > 1) { d.vx += dx / dist * .03 * (1 - dist / REACH); d.vy += dy / dist * .03 * (1 - dist / REACH); }
        }
        // Ease back to a slow drift once the pointer lets go, and never race.
        const speed = Math.hypot(d.vx, d.vy);
        const scale = speed > MAX_SPEED ? MAX_SPEED / speed : speed > CRUISE && !pointer.on ? .985 : 1;
        d.vx *= scale; d.vy *= scale;
        d.x += d.vx; d.y += d.vy;
        if (d.x < 0 || d.x > width) { d.x = Math.max(0, Math.min(width, d.x)); d.vx = -d.vx; }
        if (d.y < 0 || d.y > height) { d.y = Math.max(0, Math.min(height, d.y)); d.vy = -d.vy; }
      }
    }

    function loop() {
      step(); draw();
      frame = requestAnimationFrame(loop);
    }
    const start = () => { cancelAnimationFrame(frame); if (!still && visible && !document.hidden) frame = requestAnimationFrame(loop); };
    const move = (e: PointerEvent) => { const rect = host.getBoundingClientRect(); pointer.x = e.clientX - rect.left; pointer.y = e.clientY - rect.top; pointer.on = true; };
    const leave = () => { pointer.on = false; };
    const sized = new ResizeObserver(resize);
    const seen = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; start(); });
    sized.observe(host); seen.observe(host);
    host.addEventListener("pointermove", move);
    host.addEventListener("pointerleave", leave);
    document.addEventListener("visibilitychange", start);
    resize(); start();
    return () => {
      cancelAnimationFrame(frame);
      sized.disconnect(); seen.disconnect();
      host.removeEventListener("pointermove", move);
      host.removeEventListener("pointerleave", leave);
      document.removeEventListener("visibilitychange", start);
    };
  }, [running, quiet]);

  return <canvas ref={canvas} className="city-particles" aria-hidden="true"/>;
}

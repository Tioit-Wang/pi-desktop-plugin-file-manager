import { useCallback, useEffect, useRef, useState } from "react";
import type { T } from "../i18n";
import { formatSize } from "../lib/format";

type Props = {
  /** data URI：面板是 file:// 的沙箱页，拿不到项目里的文件路径。 */
  src: string;
  name: string;
  size: number;
  t: T;
};

type Offset = { x: number; y: number };

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
const ZOOM_STEP = 1.15;

/**
 * 图片查看。默认适应窗口；滚轮以光标为锚点缩放，任意拖拽平移。
 * 舞台铺棋盘格，PNG / GIF 的透明区域才看得出来。
 *
 * 布局与变换的关系（锚点公式依赖这一套，改布局就得改公式）：
 *   - .img-canvas 是 flex 容器，img 靠 margin:auto 居中，max-width/max-height
 *     把它的**布局盒**约束成适应尺寸（transform 不参与排版，所以布局盒永远
 *     装得进容器，margin:auto 永远是真居中）；
 *   - 图片左上角的屏幕位置 = 容器中心 - 布局盒尺寸/2（记作 L）；
 *   - 缩放与平移全部交给 transform，transform-origin: 0 0，所以图片上某点
 *     的屏幕位置 = L + offset + zoom * (该点在布局盒里的坐标)。
 * 由此推出滚轮锚点：令光标 m 指向的图片点缩放前后落在同一屏幕位置，得
 *   offset' = (m - L) - (zoom'/zoom) * (m - L - offset)
 */
export function ImageView({ src, name, size, t }: Props) {
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  // 滚轮监听是挂载时注册一次的（非 passive）， handler 里要读最新的 zoom/offset
  // 就靠这个 ref——直接闭包会拿到首帧的旧值。
  const viewRef = useRef({ zoom, offset });
  viewRef.current = { zoom, offset };
  const dragRef = useRef<{ startX: number; startY: number; startOffset: Offset } | null>(null);

  const resetView = useCallback(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  const toggleZoom = useCallback(() => {
    setZoom((current) => (current === 1 ? 2 : 1));
    setOffset({ x: 0, y: 0 });
  }, []);

  // 滚轮缩放：React 的 onWheel 是 passive 的，preventDefault 不生效，必须原生注册。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const img = imgRef.current;
      if (!img || !dimensions) return;
      const { zoom: current, offset: currentOffset } = viewRef.current;
      const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current * factor));
      if (next === current) return;
      const rect = canvas.getBoundingClientRect();
      const mx = event.clientX - rect.left;
      const my = event.clientY - rect.top;
      // L：图片左上角相对容器的坐标。padding 上下左右对称，内容区中心就是
      // 容器中心；布局盒由 flex margin:auto 居中，所以 L = 中心 - 盒尺寸/2。
      const lx = canvas.clientWidth / 2 - img.offsetWidth / 2;
      const ly = canvas.clientHeight / 2 - img.offsetHeight / 2;
      const nextOffset = {
        x: mx - lx - (next / current) * (mx - lx - currentOffset.x),
        y: my - ly - (next / current) * (my - ly - currentOffset.y),
      };
      viewRef.current = { zoom: next, offset: nextOffset };
      setZoom(next);
      setOffset(nextOffset);
    };
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", handleWheel);
  }, [dimensions]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || failed) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = { startX: event.clientX, startY: event.clientY, startOffset: offset };
      setDragging(true);
    },
    [failed, offset],
  );

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    setOffset({
      x: drag.startOffset.x + (event.clientX - drag.startX),
      y: drag.startOffset.y + (event.clientY - drag.startY),
    });
  }, []);

  const endDrag = useCallback(() => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
  }, []);

  return (
    <div className="img-stage">
      <div
        ref={canvasRef}
        className="img-canvas"
        data-dragging={dragging}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={toggleZoom}
      >
        <img
          ref={imgRef}
          src={src}
          alt={name}
          draggable={false}
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` }}
          onLoad={(event) =>
            setDimensions({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            })
          }
          onError={() => setFailed(true)}
        />
      </div>

      <div className="img-bar">
        {failed ? (
          <span style={{ color: "var(--danger)" }}>{t("imageFailed")}</span>
        ) : (
          <>
            {dimensions ? (
              <span className="img-dims">
                {dimensions.width} × {dimensions.height}
              </span>
            ) : null}
            <span>{formatSize(size)}</span>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginLeft: "auto" }}>
              <span style={{ color: "var(--secondary)" }}>{Math.round(zoom * 100)}%</span>
              {zoom !== 1 ? (
                <button type="button" className="img-zoom" onClick={resetView}>
                  {t("imageReset")}
                </button>
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

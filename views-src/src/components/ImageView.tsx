import { useState } from "react";
import type { T } from "../i18n";
import { formatSize } from "../lib/format";

type Props = {
  /** data URI：面板是 file:// 的沙箱页，拿不到项目里的文件路径。 */
  src: string;
  name: string;
  size: number;
  t: T;
};

/**
 * 图片查看。默认适应窗口，可切到实际大小（超出即滚动）。
 * 舞台铺棋盘格，PNG / GIF 的透明区域才看得出来。
 */
export function ImageView({ src, name, size, t }: Props) {
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [actual, setActual] = useState(false);

  return (
    <div className="img-stage" data-actual={actual}>
      <div className="img-canvas">
        <img
          src={src}
          alt={name}
          draggable={false}
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
        ) : null}
        {dimensions && !failed ? (
          <span className="img-dims">
            {dimensions.width} × {dimensions.height}
          </span>
        ) : null}
        <span>{formatSize(size)}</span>
        {failed ? null : (
          <button type="button" className="img-zoom" onClick={() => setActual((value) => !value)}>
            {actual ? t("imageFit") : t("imageActual")}
          </button>
        )}
      </div>
    </div>
  );
}

import { useState } from "react";
import type { T } from "../i18n";
import { formatSize } from "../lib/format";

type Props = {
  /** data URI，字节由主进程读好带过来。 */
  src: string;
  mime: string;
  name: string;
  size: number;
  t: T;
};

/**
 * 音视频播放。按 mime 的前缀决定用 <video> 还是 <audio>。
 *
 * 不自动播放：面板可能在用户没注意的时候切到媒体文件上，出声是越界的。
 * 编码或容器不被支持时（例如 .mkv 里塞了 Chromium 不认的编码）浏览器只报
 * error，所以这里给出明确提示，而不是留一块黑框。
 */
export function MediaPlayer({ src, mime, name, size, t }: Props) {
  const [failed, setFailed] = useState(false);
  const video = mime.startsWith("video/");

  return (
    <div className="media-stage">
      <div className="media-box">
        {video ? (
          <video src={src} controls playsInline preload="metadata" onError={() => setFailed(true)} />
        ) : (
          <audio src={src} controls preload="metadata" onError={() => setFailed(true)} />
        )}
      </div>

      <div className="media-meta">
        <span className="media-name" title={name}>
          {name}
        </span>
        <span>{formatSize(size)}</span>
      </div>

      {failed ? <div className="media-error">{t("mediaFailed")}</div> : null}
    </div>
  );
}

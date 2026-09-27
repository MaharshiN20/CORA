// QR code for a URL, rendered locally (no external service) as an <img> data URL.
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

export default function Qr({ value, size = 180, label }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    let live = true;
    if (!value) {
      setSrc(null);
      return undefined;
    }
    QRCode.toDataURL(value, { width: size * 2, margin: 1, errorCorrectionLevel: 'M' }).then((url) => live && setSrc(url));
    return () => {
      live = false;
    };
  }, [value, size]);
  if (!value) return <div style={{ width: size, height: size }} className="grid place-items-center rounded-lg bg-slate-100 text-xs text-slate-400">no link</div>;
  return src ? <img src={src} width={size} height={size} alt={label ?? `QR code for ${value}`} className="rounded-lg bg-white" /> : <div style={{ width: size, height: size }} />;
}

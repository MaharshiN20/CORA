// Desktop notifications for new RED alerts, for a nurse working in another window. Entirely
// optional: no API (or permission denied) means nothing happens and nothing throws.
export const canNotify = () => typeof Notification !== 'undefined';

export const notifyPermission = () => (canNotify() ? Notification.permission : 'unsupported');

// Ask the browser once (it must come from a click). -> 'granted' | 'denied' | 'default' | 'unsupported'
export async function enableNotifications() {
  if (!canNotify()) return 'unsupported';
  if (Notification.permission === 'default') {
    try {
      return await Notification.requestPermission();
    } catch {
      return Notification.permission;
    }
  }
  return Notification.permission;
}

export function notifyRed(alert, patientName) {
  if (notifyPermission() !== 'granted') return null;
  try {
    return new Notification(`🚨 RED: ${patientName}`, { body: alert.title ?? 'New RED alert', tag: alert.id, requireInteraction: true });
  } catch {
    return null;
  }
}

// Tab title: a nurse in another tab sees the count.
export const titleFor = (redCount, base = 'HeartBridge') => (redCount > 0 ? `(${redCount}) 🚨 ${base}` : base);

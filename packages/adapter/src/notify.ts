/**
 * tenfour adapter — cross-platform OS notification dispatch (WIN-005, doctor check 12).
 *
 * Best-effort, no dependencies, no shell scripts: spawns the platform's native notifier
 * directly (macOS osascript, Linux notify-send, Windows PowerShell toast via -Command
 * — this is a NATIVE toast, not a tenfour .ps1 script, so CLI-002 stands). Fires only at
 * hook moments. Returns whether the dispatch call itself was launched (doctor check 12
 * copy is honest: a launched dispatch is not proof the toast was seen).
 */

import { spawn } from 'node:child_process';

export interface NotifyResult {
  dispatched: boolean;
  detail: string;
}

export function notify(
  title: string,
  body: string,
  platform: NodeJS.Platform = process.platform,
): NotifyResult {
  try {
    if (platform === 'darwin') {
      const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`;
      spawn('osascript', ['-e', script], { stdio: 'ignore', detached: true }).unref();
      return { dispatched: true, detail: 'osascript display notification' };
    }
    if (platform === 'linux') {
      spawn('notify-send', [title, body], { stdio: 'ignore', detached: true }).unref();
      return { dispatched: true, detail: 'notify-send' };
    }
    if (platform === 'win32') {
      // Native Windows toast via the shipped Windows.UI.Notifications API (no .ps1 file).
      const ps = [
        '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null;',
        `$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);`,
        `$t.GetElementsByTagName('text')[0].AppendChild($t.CreateTextNode(${JSON.stringify(title)})) > $null;`,
        `$t.GetElementsByTagName('text')[1].AppendChild($t.CreateTextNode(${JSON.stringify(body)})) > $null;`,
        `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('tenfour').Show([Windows.UI.Notifications.ToastNotification]::new($t));`,
      ].join(' ');
      spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
        stdio: 'ignore',
        detached: true,
      }).unref();
      return { dispatched: true, detail: 'windows toast' };
    }
    return { dispatched: false, detail: `no notifier for platform ${platform}` };
  } catch (e) {
    return { dispatched: false, detail: `dispatch error: ${(e as Error).message}` };
  }
}

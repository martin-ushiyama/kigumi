/** The single channel for pushing a transient message to the status bar etc. (*  extracted from main.ts — services/modules outside the composition root never
 *  touch `window` directly, they receive this function via injection) */
export function toast(message: string): void {
  window.dispatchEvent(new CustomEvent('bs-toast', { detail: message }));
}

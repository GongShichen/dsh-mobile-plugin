/** Scoped tokens inherit the host's light/dark palette; no global reset. */
export const mobileStyles = `
.dsh-mobile-modal{width:min(920px,calc(100vw - 40px))!important;max-width:calc(100vw - 40px)!important;max-height:calc(100dvh - 48px)!important}
.dsh-mobile-modal-content{max-height:calc(100dvh - 64px);overflow-y:auto;overscroll-behavior:contain}
.dm-launcher{appearance:none;display:flex;align-items:center;justify-content:center;gap:10px;background:transparent;border:0;box-shadow:none;color:var(--dsw-alias-label-primary,inherit);width:36px;min-height:36px;padding:8px;cursor:pointer;font:500 14px/20px var(--dsw-font-family,-apple-system,BlinkMacSystemFont,sans-serif);border-radius:9px;text-align:left;transition:background-color .16s ease}
.dm-launcher-wide{width:100%;justify-content:flex-start;padding:9px 12px}.dm-launcher svg{flex-shrink:0}.dm-launcher:hover{background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 7%,transparent))}.dm-launcher:focus-visible{outline:2px solid #6f93ff;outline-offset:2px}.dm-launcher:active{background:color-mix(in srgb,currentColor 11%,transparent)}
.dsh-mobile-access{--dm-ink:var(--dsw-alias-label-primary,#182230);--dm-muted:var(--dsw-alias-label-secondary,#5e6878);--dm-surface:var(--dsw-alias-bg-layer-1,#fff);--dm-soft:var(--dsw-alias-bg-module-platform,#f6f7fa);--dm-border:var(--dsw-alias-border-l2,#dde2eb);--dm-accent:#355ce0;--dm-success:var(--dsw-alias-label-primary,#182230);--dm-error:var(--dsw-alias-state-error-primary,#b63838);font-family:var(--dsw-font-family,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif);font-size:14px;line-height:1.6;color:var(--dm-ink);display:grid;gap:24px;min-width:0;padding-top:4px}
.dsh-mobile-access *{box-sizing:border-box}
.dsh-mobile-access h2,.dsh-mobile-access h3,.dsh-mobile-access p{margin:0}
.dsh-mobile-access h2{font-size:24px;line-height:1.35;font-weight:650;letter-spacing:-.55px;text-wrap:balance}
.dsh-mobile-access h3{font-size:15px;line-height:1.5;font-weight:650}
.dsh-mobile-access strong{font-weight:600}
.dsh-mobile-access button,.dsh-mobile-access input,.dsh-mobile-access select{font:inherit}
.dsh-mobile-access button{cursor:pointer;transition:background-color .16s ease,border-color .16s ease,color .16s ease}
.dsh-mobile-access button:disabled{cursor:not-allowed;opacity:.45}
.dsh-mobile-access :is(button,input,select,a,summary):focus-visible{outline:2px solid var(--dm-accent);outline-offset:3px}
.dm-tabs{display:flex;align-items:center;gap:4px;padding:4px;background:var(--dm-soft);border-radius:12px}
.dm-tabs>button{border:0;background:transparent;color:var(--dm-muted);padding:9px 18px;border-radius:9px;min-height:40px;font-weight:550}
.dm-tabs>button[aria-pressed=true]{background:var(--dm-surface);color:var(--dm-ink);box-shadow:0 1px 4px #0000000b}
.dm-tabs>.dm-status{margin-left:auto;margin-right:12px}
.dm-status{display:inline-flex;align-items:center;gap:7px;font-size:12px;white-space:nowrap;color:var(--dm-muted)}
.dm-status i{width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.7}
.dm-online i{background:#21946c;opacity:1}
.dm-pairing{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:32px;align-items:center;padding:8px 0 16px}
.dm-pairing-copy{display:grid;gap:14px;padding:8px 0}
.dm-eyebrow{font-size:11px;letter-spacing:2px;font-weight:650;color:var(--dm-muted)}
.dm-brand{display:flex;align-items:center;gap:10px}.dm-brand>svg{color:var(--dm-accent,#355ce0);flex-shrink:0}
.dm-muted{color:var(--dm-muted);font-size:13px;line-height:1.65}
.dm-steps{list-style:none;padding:0;margin:8px 0 2px;display:grid;gap:18px}
.dm-steps li{display:flex;gap:12px;align-items:flex-start}
.dm-steps li>span{width:26px;height:26px;display:grid;place-items:center;border:1px solid var(--dm-border);border-radius:50%;font-size:12px;color:var(--dm-muted);flex-shrink:0}
.dm-steps strong{font-size:13px}
.dm-steps p{font-size:12px;color:var(--dm-muted)}
.dm-host{display:flex;align-items:center;gap:8px;margin-top:8px;padding-top:16px;border-top:1px solid var(--dm-border);font-size:13px;min-width:0}
.dm-host>span:first-of-type{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dm-badge{font-size:11px;padding:2px 8px;background:var(--dm-soft);border-radius:6px;color:var(--dm-muted);white-space:nowrap}
.dm-qr-panel{display:flex;flex-direction:column;align-items:center;gap:10px;padding:18px;background:var(--dm-soft);border:1px solid var(--dm-border);border-radius:20px}
.dm-qr-square{width:300px;max-width:100%;aspect-ratio:1;background:#fff;border-radius:12px;display:grid;place-items:center;overflow:hidden;border:1px solid #e6e9ef}
.dm-qr-square img{display:block;width:100%;height:auto}
.dm-qr-placeholder{display:grid;justify-items:center;gap:18px;color:#5e6878;font-size:12px}
.dm-button{border-radius:10px;min-height:40px;padding:9px 15px;border:1px solid var(--dm-border);background:var(--dm-surface);color:var(--dm-ink);display:inline-flex;justify-content:center;align-items:center;gap:7px;font-weight:550}
.dm-primary{background:var(--dm-accent);border-color:var(--dm-accent);color:#fff}
.dm-primary:hover:not(:disabled){background:#294dc3;border-color:#294dc3}
.dm-secondary:hover:not(:disabled){background:var(--dm-soft)}
.dm-qr-panel>.dm-button{width:100%}
.dm-caption{font-size:12px;color:var(--dm-muted);line-height:1.6}
.dm-link{border:0;background:transparent;color:var(--dm-ink);font-size:12px;display:inline-flex;align-items:center;gap:6px;min-height:32px;padding:4px 8px;border-radius:6px}
.dm-link:hover{background:color-mix(in srgb,var(--dm-ink) 5%,transparent)}
.dm-section-heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
.dm-panel{border:1px solid var(--dm-border);border-radius:16px;padding:20px;background:var(--dm-surface);display:grid;gap:14px}
.dm-pending{background:color-mix(in srgb,var(--dm-accent) 4%,var(--dm-surface))}
.dm-pending-row,.dm-device{display:flex;align-items:center;gap:12px;min-width:0}
.dm-actions{display:flex;align-items:center;gap:8px;flex-shrink:0}
.dm-icon-tile{display:grid;place-items:center;width:42px;height:42px;flex-shrink:0;border-radius:12px;background:var(--dm-soft);color:var(--dm-ink)}
.dm-grow{flex:1;min-width:0}.dm-grow strong{overflow-wrap:anywhere}
.dm-empty{display:flex;gap:16px;align-items:center;padding:22px;border:1px dashed var(--dm-border);border-radius:14px;color:var(--dm-muted)}
.dm-empty strong{font-size:13px;color:var(--dm-ink)}.dm-empty p{font-size:12px}
.dm-device{padding:16px 0;border-top:1px solid var(--dm-border)}
.dm-device:first-of-type{border-top:0}.dm-dot-separator{padding:0 7px}
.dm-identity{font-size:11px;color:var(--dm-muted);margin-top:3px}
.dm-identity summary{cursor:pointer;width:max-content}.dm-identity code{display:block;overflow-wrap:anywhere;margin-top:8px;font-size:11px}
.dm-device-actions{position:relative}.dm-device-actions summary{list-style:none;cursor:pointer;min-width:36px;min-height:36px;display:grid;place-items:center;border-radius:8px;font-weight:700;color:var(--dm-muted)}
.dm-device-actions summary::-webkit-details-marker{display:none}.dm-device-actions[open]>summary{background:var(--dm-soft)}
.dm-device-actions>div{position:absolute;right:0;top:40px;z-index:2;width:140px;border:1px solid var(--dm-border);padding:5px;background:var(--dm-surface);box-shadow:0 8px 28px #00000015;border-radius:10px;display:grid}
.dm-device-actions button{border:0;background:transparent;padding:9px 12px;text-align:left;color:var(--dm-ink);border-radius:6px}.dm-device-actions button:hover{background:var(--dm-soft)}
.dm-footnote{display:flex;align-items:center;justify-content:center;gap:6px;color:var(--dm-muted);font-size:11px;border-top:1px solid var(--dm-border);padding-top:16px}
.dm-feedback{padding:10px 14px;border-radius:10px;background:color-mix(in srgb,var(--dm-accent) 7%,var(--dm-surface));font-size:13px}
.dm-error,.dm-danger{color:var(--dm-error)!important}.dm-error{background:color-mix(in srgb,var(--dm-error) 7%,var(--dm-surface))}
.dm-loading{padding:56px;text-align:center;color:var(--dm-muted)}
.dm-notification-intro{display:flex;gap:16px;align-items:flex-start}.dm-notification-intro h2{font-size:22px;margin-bottom:8px}
.dm-provider-status{display:flex;gap:20px;font-size:12px;color:var(--dm-muted)}.dm-provider-status strong{color:var(--dm-ink);padding-left:7px}
.dm-form{display:grid;gap:16px;min-width:0}.dm-form label{font-size:12px;font-weight:500}
.dm-form input,.dm-push-form select{min-height:42px;width:100%;border:1px solid var(--dm-border);background:var(--dm-surface);border-radius:9px;padding:9px 12px;color:var(--dm-ink);outline-offset:3px;font-size:14px}
.dm-form input[type=file]{font-size:12px}.dm-form input::file-selector-button{border:0;border-radius:6px;background:var(--dm-soft);color:var(--dm-ink);padding:5px 9px;margin-right:10px;cursor:pointer}
.dm-form a{font-size:12px;color:var(--dm-ink);text-underline-offset:3px}.dm-form .dm-button{justify-self:start;padding-inline:24px}
.dm-history{border-top:1px solid var(--dm-border);padding-top:16px}.dm-history>summary{cursor:pointer;font-weight:550;min-height:32px}.dm-history>summary span{margin-left:8px;color:var(--dm-muted);font-weight:400}.dm-history>p{padding:14px 0}
.dm-history-row{display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding:12px 0;border-bottom:1px solid var(--dm-border);font-size:12px}.dm-history-row strong{margin-left:auto}
@media(max-width:640px){.dsh-mobile-modal{max-width:calc(100vw - 16px)!important;width:calc(100vw - 16px)!important;max-height:calc(100dvh - 16px)!important}.dsh-mobile-modal-content{max-height:calc(100dvh - 32px)}.dsh-mobile-access{gap:20px}.dm-pairing{grid-template-columns:1fr;gap:20px}.dm-pairing-copy h2{font-size:22px}.dm-qr-panel{max-width:320px;width:100%;justify-self:center}.dm-tabs>.dm-status{display:none}.dm-pending-row{flex-wrap:wrap}.dm-pending-row .dm-actions{width:100%;justify-content:flex-end}.dm-device>.dm-status{display:none}.dm-form .dm-button{width:100%}.dm-notification-intro h2{font-size:20px}}
@media(prefers-reduced-motion:reduce){.dsh-mobile-access *{transition:none!important;animation:none!important}}
`;

/** Loaded inside the private presets; global registrations remain masked for these roles. */
export const name = 'hl-personal-scope'
export const inject = ['tools']
interface HLScopeContext {
  tools: { get(name: string): unknown; restrict(filter: { allow: string[] }): () => void }
  effect(factory: () => (() => void)): unknown
}
export function apply(ctx: HLScopeContext, config: { role: string }): void {
  const tools = config.role === 'scheduler' ? ['hl_personal_claim_scheduled'] : [
    'hl_personal_context', 'hl_personal_request_google', 'hl_personal_create_goal', 'hl_personal_update_goal', 'hl_personal_create_task', 'hl_personal_append_task', 'hl_personal_cancel_task', 'hl_personal_resume_task',
    'hl_personal_list_tasks', 'hl_personal_list_goals',
    'hl_personal_list_routines', 'hl_personal_edit_routine',
    'hl_personal_list_workspaces', 'hl_personal_list_sessions', 'hl_personal_remember', 'hl_personal_create_routine',
    'hl_personal_task_report', 'hl_personal_query', 'hl_personal_prepare_action', 'hl_personal_commit_action',
    'hl_personal_wait_until', 'hl_personal_write_artifact', 'hl_personal_list_attachments', 'hl_personal_read_attachment', 'ask_user_question', 'web_search', 'web_fetch',
  ]
  ctx.effect(() => ctx.tools.restrict({ allow: tools.filter(name => ctx.tools.get(name) !== undefined) }))
}

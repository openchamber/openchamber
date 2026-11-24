export const ACTIONS_PARAMETER_PROPERTIES = {
  name: { type: 'string', description: 'actions.run, logs, stop: an action id or name from actions.list' },
  maxBytes: { type: 'integer', minimum: 1, maximum: 262144, description: 'actions.logs: how much of the end to return, 32768 by default, 262144 at most' },
};

export const ACTIONS_TOOL_DESCRIPTION = "Project actions: the commands the user saved to run this project, such as its dev server, the same ones the actions menu runs. "
  + "actions.list shows the ones for this computer, then actions.run starts one in the folder it belongs to (this session's folder, or the project root for some). "
  + "A run is a background terminal the user sees in the actions menu, marked as started by you; read what it printed with actions.logs and stop it with actions.stop once it is no longer needed. "
  + "When the action already runs, run starts no second copy and tells you whose run it is: a run the user or another session started is theirs, so use it and read its output, but never stop or restart it.";

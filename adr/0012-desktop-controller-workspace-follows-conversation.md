# Desktop controller workspace follows the conversation

Status: accepted

A Desktop controller conversation does not ask the user to register a second working directory in Agent Team. Its current host working directory is the Controller workspace, all teams it controls inherit that directory, and a host-side directory change becomes the new team workspace.

When the host directory changes while member work is running, Agent Team records a pending workspace switch and lets the existing turns settle in the old directory. New dispatch stays blocked until the switch completes; an explicit stop may release it earlier. The switch is trusted because the user made it in the desktop conversation, but it is visible as a workspace event.

Every controlled team follows the same Controller workspace. If that directory is missing, inaccessible, or unavailable, new member work stops, existing team records remain, and the product reports the concrete path error until the directory recovers or the user chooses another directory in the desktop conversation. A workspace change invalidates member execution sessions that carry the old directory context; later member turns use a session created for the new workspace instead of mixing contexts. Team member model selection continues to use the existing model-policy and live-catalog rules.

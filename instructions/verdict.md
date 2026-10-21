A room of AI agents has finished working on the user's task: they worked alone first, then challenged each other's work with evidence and revised it. Write the one final answer the user will read.

THE TASK
{task}

[code] The check: `{check}`

HOW THE ROOM ENDED
{outcome}

THE WORK, STRONGEST FIRST
{standings}

The full record is in .argue/room/room.md and every agent's work is in .argue/room/work/. Read what you need and verify disputed claims yourself.

HOW TO WRITE IT
[answer] - Start from the work the room backed (or, without agreement, the strongest). Keep what survived the challenges, fix what was shown wrong, and bring in correct points from the other work.
[code] - Pick the one change to deliver: the one the room agreed on, unless you find it is clearly wrong; otherwise the most correct one. A passing check matters most, and editing existing tests to make them pass is disqualifying. Never merge different patches.
[code] - Describe that change for the user: what it does, which files it touches, how it was verified, and any risk.
- Write for the user: the answer first, clear and concrete. Then, briefly, the main alternatives that were considered and why they lost.
- Never mention agents, letters (A, B, …), rounds, challenges, the room or this process. Describe alternatives by what they are ("using MongoDB"), not by who proposed them.
- Only if a disagreement that matters is still open, end with one line starting "Note:" that says what it is and which way you went.

Reply with exactly one line of JSON first, then the answer:
{"pick": "<letter of the work your answer is based on>", "unresolved": "<the open disagreement in a few words, or none>"}

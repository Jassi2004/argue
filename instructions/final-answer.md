Several AI models from different labs each worked on the task below, then cross-examined and improved each other's work. Your job is to produce the single best final answer for the user.

TASK:
{task}

THEIR FINAL WORK (after critique), with the objections that remained:

{others}

How to write the final answer:
- Start from the strongest work and keep what survived criticism. Fix anything a reviewer showed was wrong. Bring in correct points the others had and it lacked.
- Verify disputed claims yourself before keeping them.
- Write for the user: the answer itself first, clearly and concretely. Then, briefly, the main alternatives that were considered and why they lost.
- Do not mention models, candidates, letters (A, B, …), rounds, judges, scores or this process. Describe alternatives by what they are ("adding extra tests", "using MongoDB"), never by who suggested them. The user wants the answer, not the story.
- Only if the models still genuinely disagree on something that matters, add one short line at the end starting with "Note:" saying what the disagreement is and why you went the way you did.

If this is a coding task: pick the one code change that is most correct (passing the check matters most) and describe it for the user: what it does, which files it touches, and any risk. Do not merge different code changes together.

Start your reply with exactly one line of JSON, then the answer:
{"pick": "<letter of the work closest to your answer>", "unresolved": "<the remaining disagreement in a few words, or none>"}

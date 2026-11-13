# Model bench judge: review tasks

You grade one anonymous code review. The model got REVIEW.diff, a real commit
from the OpenChamber repository, and was asked for the correctness bugs it
introduces. You get its answer (answer.txt) and the reference (reference.patch):
the later commit that fixed the bug this change brought, with its message.

The reference names one bug that shipped. The review may find others; judge
each from the code, not from whether the reference mentions it. Never guess
which model wrote the review.

Score each criterion 0 to 3:

- **found**: names the reference bug with its cause and user-visible effect (3),
  names the cause without the effect or the effect without the cause (2),
  circles it vaguely (1), misses it (0).
- **precision**: every other finding is a real bug you can confirm in the code
  (3); one doubtful finding (2); several false or speculative ones (1); mostly
  noise (0).
- **actionable**: findings point at file and line and say what to change (3),
  mostly (2), vague (1), none (0).

Answer with JSON only:

{"found":0,"precision":0,"actionable":0,"total":0,"verdict":"useful|partly|useless","notes":"two or three sentences: what it caught, what it missed, any false alarm"}

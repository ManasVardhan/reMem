# Precision audit: LoCoMo flagged items

The classifier flagged 5 of 300 LoCoMo questions as requiring contradiction
resolution. For each, decide whether the two quoted assertions genuinely
conflict **on the property the question asks about**.

NOT a contradiction: two separate events, an elaboration or restatement, two
different speakers, or two statements that are simply both true.

Record answers in `eval/density/labels/precision-audit.jsonl`, one per line:

    {"id": "<id>", "genuine": true}
    {"id": "<id>", "genuine": false}

Note: the paper's conclusion does not depend on the outcome. All five genuine
gives 1.7 percent density; all five false gives 0.0 percent. Either way LoCoMo
is near zero against fact consolidation's 81 percent. The audit sets the
precision figure, not the finding.

---

## 1. `conv-42-q113-c4`

**Question:** What is Nate's favorite genre of movies?

**Gold answer:** Fantasy and sci-fi

**Quoted as the earlier assertion:**

> I love action and sci-fi movies, the effects are so cool! What about you, what's your favorite genre?

**Quoted as the later assertion** (contains the gold answer):

> I love fantasy and sci-fi movies, they're a great escape and get my imagination going. Playing video games is a great way to express my creativity and passion.

Genuine contradiction?  `[ ] yes`   `[ ] no`

---

## 2. `conv-42-q158-c4`

**Question:** What kind of cake did Joanna share a photo of that she likes making for birthdays and special days?

**Gold answer:** chocolate cake with raspberries

**Quoted as the earlier assertion:**

> It's dairy-free vanilla with strawberry filling and coconut cream frosting. I gotta say, I really like your coconut reccomendation you gave a while back!

**Quoted as the later assertion** (contains the gold answer):

> Hey Nate, I love making this dairy-free chocolate cake with raspberries. It's so moist and delicious - perfect sweetness level.

Genuine contradiction?  `[ ] yes`   `[ ] no`

---

## 3. `conv-47-q138-c4`

**Question:** What inspired James to create his game?

**Gold answer:** Witcher 3

**Quoted as the earlier assertion:**

> I've always loved playing strategy games like Civilization and Total War, so I decided to challenge myself and create one of my own.

**Quoted as the later assertion** (contains the gold answer):

> Playing video games was always great, but creating my own game was really special. Witcher 3 gave me a ton of inspiration, with its amazing world and story. Plus, it pushed me to create something cool.

Genuine contradiction?  `[ ] yes`   `[ ] no`

---

## 4. `conv-48-q136-c4`

**Question:** Which new yoga pose did Deborah share a photo of?

**Gold answer:** tree pose

**Quoted as the earlier assertion:**

> By the way, I tried a new pose - Dancer Pose (Natarajasana). Rate, did I succeed?

**Quoted as the later assertion** (contains the gold answer):

> I'd rather show you a photo. This is also a new yoga pose that we tried. It is a tree pose.

Genuine contradiction?  `[ ] yes`   `[ ] no`

---

## 5. `conv-49-q139-c4`

**Question:** How did Evan describe the process of creating the painting with the bird flying over it?

**Gold answer:** embracing the creative process without restraint

**Quoted as the earlier assertion:**

> The painting is mine, I made it when I was a mix of emotions - sad, mad, and hopeful. Art is amazing how it can portray feelings without words.

**Quoted as the later assertion** (contains the gold answer):

> I painted this with a sense of joy and freedom. The spontaneous strokes and bold colors reflect a playful and liberated mood, embracing the creative process without restraint.

Genuine contradiction?  `[ ] yes`   `[ ] no`

---

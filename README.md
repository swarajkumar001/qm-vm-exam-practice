# ExamPrep — Quality Management & Vendor Management MSQ/MCQ Practice

An interactive practice site for **Quality Management – Session 11** and **Vendor Management & Contracts – Session 7** (Business Fundamentals, Dr. Himanshu Warudkar).

It is a static website (HTML, CSS, vanilla JavaScript and one JSON file). There is no backend, database, build step, or `npm install`, so it runs on **GitHub Pages for free**.

- **509 questions**: 302 MSQs (multiple select) and 207 MCQs (single answer)
  - `msq001`–`msq127` and all MCQs come from the original question bank PDF
  - `msq128`–`msq302` (175 MSQs) were written directly from the two lecture slide decks
- Every question has four options, an answer key, an explanation for each option, and a source reference (PDF page and slide)
- Instant answer checking: an MSQ is only correct when your selected set exactly matches the answer key
- 10 practice modes, an exam mode with an optional timer, results and review, search, bookmarks, and light/dark themes

---

## Project structure

```
exam-practice-website/
├── index.html                 # App shell (layout, nav, icons)
├── assets/slides/             # The two lecture PDFs (viewable + downloadable in "Slides & Revision")
├── README.md
├── .nojekyll                  # Tells GitHub Pages to serve files as-is
└── assets/
    ├── css/styles.css         # All styling, light + dark themes, responsive layout
    ├── js/validator.js        # Question bank validation
    ├── js/app.js              # Application logic
    ├── img/favicon.svg
    ├── data/questions.json    # The question bank (edit this to add questions)
    └── data/revision.json     # Slide summaries, key concepts and formulas
```

All paths are relative (for example `assets/data/questions.json`), so the site works at `https://<user>.github.io/<repo>/` as well as at a domain root.

---

## Deploy to GitHub Pages (step by step)

### 1. Download the project
Download `exam-practice-website.zip` and unzip it. You should see `index.html`, `README.md`, `.nojekyll` and the `assets` folder.

> `.nojekyll` starts with a dot, so some file managers hide it. It is included in the zip. If it gets lost, create an empty file with that name in the project root.

### 2. Create a GitHub repository
1. Sign in at <https://github.com> and click **New** (or go to <https://github.com/new>).
2. Name the repository, e.g. `exam-practice`.
3. Choose **Public**. GitHub Pages is free for public repositories. Private repositories need a paid plan for Pages.
4. Click **Create repository**.

### 3. Upload or push the files

**Option A — upload in the browser (easiest)**
1. In the new repository, click **uploading an existing file** (or **Add file → Upload files**).
2. Drag in the **contents** of the `exam-practice-website` folder: `index.html`, `README.md`, `.nojekyll` and the whole `assets` folder. `index.html` must end up at the top level of the repository, not inside a subfolder.
3. Click **Commit changes**.

> If drag-and-drop skips `.nojekyll`, add it with **Add file → Create new file**, name it `.nojekyll`, leave it empty, and commit.

**Option B — git on the command line**
```bash
cd exam-practice-website
git init
git add .
git commit -m "Exam practice website"
git branch -M main
git remote add origin https://github.com/<your-username>/exam-practice.git
git push -u origin main
```

### 4. Open repository Settings
In the repository, click the **Settings** tab, then **Pages** in the left sidebar.

### 5. Enable GitHub Pages from the main branch and root
Under **Build and deployment**:
- **Source**: *Deploy from a branch*
- **Branch**: `main`, folder `/ (root)`
- Click **Save**.

### 6. Wait for deployment
GitHub builds the site, which usually takes 1–2 minutes. You can watch progress in the **Actions** tab ("pages build and deployment"). When it finishes, the Pages settings show *"Your site is live at …"*.

### 7. Open the published website
Visit `https://<your-username>.github.io/<repository-name>/`, e.g. `https://yourname.github.io/exam-practice/`.

---

## Test locally (optional)

Browsers block loading `questions.json` when you double-click `index.html` (a `file://` address), so the page would show a "could not be loaded" message. Run a small local web server instead:

```bash
cd exam-practice-website
python -m http.server 8000
# then open http://localhost:8000
```

(Any static server works, e.g. `npx serve`.) This step is only for local testing. GitHub Pages needs nothing extra.

---

## Adding more questions

All questions live in `assets/data/questions.json`. You never need to touch the JavaScript.

The file looks like this:

```json
{
  "meta": { "title": "...", "validation": { "strictMsq": false } },
  "questions": [ { ...question... }, { ...question... } ]
}
```

(A plain array of questions also works.)

### Question format

```json
{
  "id": "q335",
  "type": "MSQ",
  "course": "Quality Management",
  "topic": "Economics and Cost of Quality",
  "difficulty": "Medium",
  "question": "Which of the following are prevention costs?",
  "options": [
    { "id": "A", "text": "Training" },
    { "id": "B", "text": "Warranty claims" },
    { "id": "C", "text": "Process design" },
    { "id": "D", "text": "Scrap" }
  ],
  "correctAnswers": ["A", "C"],
  "explanation": "Training and process design prevent defects; warranty claims and scrap are failure costs.",
  "optionExplanations": {
    "A": "Correct – training is a prevention cost.",
    "B": "Incorrect – warranty claims are an external-failure cost.",
    "C": "Correct – designing the process well prevents defects.",
    "D": "Incorrect – scrap is an internal-failure cost."
  },
  "hint": "Think about money spent before a defect exists.",
  "source": { "file": "Quality Management - Session 11 - Updated.pdf", "page": 23, "slide": "24" }
}
```

| Field | Required | Notes |
|---|---|---|
| `id` | yes | Must be unique. |
| `type` | yes | `"MSQ"` or `"MCQ"`. |
| `question` | yes | Question text. |
| `options` | yes | Array of `{ "id", "text" }`. Four options recommended. |
| `correctAnswers` | yes | Option ids. **MCQ: exactly one.** MSQ: one or more (see below). |
| `explanation` | yes | Shown after checking when there are no per-option explanations. |
| `optionExplanations` | no | One explanation per option id, shown next to each option after checking. |
| `course`, `topic` | no | Used for filters and topic progress (defaults to "General"). |
| `difficulty` | no | `Easy`, `Medium` or `Hard`. |
| `tag` | no | Extra label, e.g. `Numerical`, `Tricky`. |
| `hint` | no | If missing, a hint is generated from the slide reference (and, for MSQs, the number of correct options). |
| `source` | no | `file`, `page` (whole number), optional `pages` / `slide` text. |

**MSQ rule.** The original question bank deliberately varies MSQ answer counts from 1 to 4. By default (`"strictMsq": false`), an MSQ with a single correct option, or with every option correct, is accepted and listed as a *warning*. Set `"strictMsq": true` in `meta.validation` to reject those MSQs instead (they then need 2+ correct options and at least one incorrect option).

### Validation
On every load, `assets/js/validator.js` checks each question for missing or duplicate ids, invalid types, empty question/option text, duplicate option ids, answers that don't match an option, MCQs without exactly one answer, and missing explanations.
- Questions with **errors** are excluded and listed under **Settings → Question bank health** (also in the browser console), and the dashboard shows a warning.
- If the file is not valid JSON, the site shows a clear error message instead of a blank page.

Tip: check your edits at <https://jsonlint.com> before uploading. A missing comma is the most common mistake.

## Updating the website after changing the question bank
1. Edit `assets/data/questions.json` (locally or with the ✏️ edit button on GitHub).
2. Commit/upload the changed file to the `main` branch (`git add . && git commit -m "Add questions" && git push`, or **Commit changes** in the GitHub editor).
3. GitHub Pages redeploys automatically in a minute or two.
4. Reload the site. If you still see the old version, do a hard refresh (Ctrl + F5 / Cmd + Shift + R).

Saved progress is kept. If you delete a question, its progress and bookmarks are dropped automatically. If you change an existing question's answer key, give it a new `id` so old attempts don't carry over.

---

## Features

**Dashboard**: total/MSQ/MCQ counts, attempted, correct, incorrect, accuracy (latest and first-try), bookmarks, current session progress, Continue Practice, MSQ and MCQ cards, topic-wise progress, and recent activity.

**Practice screen**: question number and progress bar, MSQ/MCQ badge, course, topic, difficulty, checkboxes for MSQs and radio buttons for MCQs, Check Answer, Clear, Previous/Next, Skip, Bookmark, Hint, a question navigator, and a timer.

**Answer checking**
- MCQ: correct only if the single selected option is the answer.
- MSQ: correct only if the selected set **exactly** equals the answer set. Partial or extra selections are incorrect.
- Feedback: green "Correct Answer!" or red "Incorrect Answer". Correct options turn green, wrong picks turn red, and missed correct options are marked. You also get a plain-language "why it's wrong", the full answer, an explanation for every option, and the source slide.
- Options lock after checking. **Try again** unlocks them. A question is scored once per session and retries update the same record, so there are no duplicate attempts.
- Clicking Check with nothing selected shows a message and records nothing.
- Answers are never shown before you check, except in the **Question bank**, where you click "Show answer" on purpose.

**Practice modes**
1. All Questions
2. MSQ Practice
3. MCQ Practice
4. Topic Practice
5. Difficulty Practice
6. Incorrect Questions
7. Bookmarked Questions
8. Random Practice
9. Exam Mode (answer everything, submit, then review; optional time limit with auto-submit)
10. Revision Mode (questions you have already attempted)

Plus a course filter, shuffled question order, shuffled options (grading uses option ids, so keys stay correct), and custom sets built from Question bank searches.

**Results**: score, attempted, correct, incorrect, accuracy, MSQ accuracy, MCQ accuracy, topic-wise accuracy, time taken, unanswered, and question-by-question review. Buttons: Review Incorrect, Retry Incorrect, Restart Quiz, Dashboard. Recent sessions are listed too.

**Slides & Quick Revision** (`#/revision`): both lecture PDFs with an in-page viewer (opens at the relevant page), "Open in new tab" and "Download". Each deck has an overview and section-by-section exam summaries (key points, tables, "exam trap" tips) with a contents sidebar. There are also formula cards with worked examples, number strips (DPMO by sigma level, SLA downtime), a key-concepts glossary, search with highlighting, expand/collapse, "Mark as revised" progress (saved in the browser) and a "Practise N questions" button per section. To edit or extend the notes, change `assets/data/revision.json`: each deck has `sections` (title, PDF `pages`, `topic` matching the question bank, `points`, optional `table` and `tip`), `formulas` and `concepts`. Use `**bold**` and `*italic*` in text. Note: inline PDF preview doesn't work on some phones; the Open/Download buttons always do.

**Question bank**: keyword search (all words must match, with highlighting), filters (course, topic, type, difficulty, status), an answer key per question, "Practise these N", and bookmarks.

**Keyboard shortcuts** (on the practice screen): `1`–`4` select options · `Enter` check, then next · `→`/`N` next · `←`/`P` previous · `S` skip · `B` bookmark · `H` hint · `R` try again · `C` clear · `?` help.

**Accessibility**: semantic HTML, real form controls, visible focus rings, ARIA labels and live regions, status shown with icons and text (not color alone), reduced-motion support, and good contrast in both themes.

---

## About saved progress (LocalStorage)
Progress, bookmarks, history and settings are stored in your browser's **LocalStorage**:
- It is **specific to one browser on one device**. It does **not** sync to your phone, another browser, or another computer, and nothing is sent to a server.
- Clearing site data / browser history, or using a private window, removes it.
- To move progress, use **Settings → Export progress** and **Import progress** on the other device.
- **Settings → Reset all progress** deletes it (after a confirmation).

---

## Known limitations
- Questions 1–334 were taken from the provided `MSQ_MCQ_Question_Bank.pdf`, which cites the two lecture PDFs. Answer keys were cross-checked against that PDF's own answer key. Facts and numerical answers were spot-checked against the slides, but not every one of those 334 questions was re-verified by hand.
- The 175 added MSQs (`msq128`–`msq302`) were written from the slide text and the image-only slides (SERVQUAL, Gap Model, linkages, BATNA/ZOPA). Each has 2–3 correct options and at least one incorrect option. Wrong options are plausible distractors taken from other parts of the slides, and every option's explanation cites the slide. Numerical questions (e.g. "1,000,000 transactions at 99.99%") apply the slides' own formulas to new numbers.
- Difficulty: the source tags (Easy, Medium, Hard, Tricky, Numerical, Application, Conceptual) are mapped to Easy/Medium/Hard (Tricky → Hard; Numerical/Application/Conceptual → Medium). The original tag is still shown as a badge. Most questions are therefore "Medium".
- 20 MSQs have either one correct option or all four correct, as in the source bank (see "MSQ rule" above).
- Some per-option explanations in the source are brief (e.g. "not supported by the source").
- Progress is per browser (see above). There are no accounts or cloud sync.
- The Inter web font loads from Google Fonts. If it is unavailable (offline), the site uses system fonts and everything else works.

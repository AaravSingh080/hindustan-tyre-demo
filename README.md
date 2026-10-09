# Hindustan Tyre Agencies: website redesign demo

A redesign demo of the website of Hindustan Tyre Agencies, a tyre dealer in Ludhiana, Punjab. It is a demo, not the shop's live site: buying still happens on the shop's own store, and this site hands over to it.

## What is in it

| Part | What it does | Where |
|---|---|---|
| Home page | Scroll-driven hero, tyre finder, categories, brands, reviews, FAQ | `index.html`, `css/styles.css`, `js/main.js` |
| Find my tyres | One question per screen: vehicle, company, model, size or brand | `tyres/`, `js/tyres.js` |
| Compare | Two or three tyres side by side | `compare/`, `js/compare.js` |
| Tyre passport | A customer's record: tyres fitted, bill, warranty, service history | `passport/`, `js/passport.js` |
| Staff desk and owner page | Sales, stock, reminders, numbers | `staff/`, `admin/` |
| Chat assistant | Answers from the shop's own facts | `js/chat.js`, `server/chat.js`, `config/chatbot.json` |
| Server | Sign-in, one-time codes, database, API | `server/` |
| Tests | Automated checks for the pages and the server | `test/` |

Plain HTML, CSS and JavaScript. No framework and no build step for the site itself. The server is Node.js with its built-in SQLite database.

## Run it on your computer

Needs Node.js 22.15.1.

```bash
npm install
npm start
```

Then open http://localhost:4173. With no settings it runs as a demo: sample customers only, and no message is sent to anyone. The settings for a live site are explained in `.env.example`.

## Tests

```bash
npm test
```

## The preview on GitHub Pages

Every push to `main` runs the tests and publishes a preview with GitHub Pages (`.github/workflows/pages.yml`). GitHub Pages serves plain files and runs no server, so the preview is a copy made by `tools/build-pages.js`:

- **Works there:** the home page, Find my tyres, Compare, the privacy page, and the chat, which answers from the shop's built-in list of questions.
- **Does not work there:** signing in to the tyre passport, the staff desk and the owner page. Those pages say so across the top, and nothing typed there is sent anywhere.

To run every feature the site needs a host that runs Node.js and keeps a disk between restarts.

To build and look at the preview copy yourself:

```bash
node tools/build-pages.js --out ../preview --base /repo-name
node tools/preview-pages.js ../preview --base /repo-name
```

## Credits

Fonts: Teko, Hind and Mukta Mahee, under the SIL Open Font License. Icons: Phosphor, under the MIT License. The licence texts are in `THIRD-PARTY-LICENSES.txt`. Brand names and logos belong to their owners.

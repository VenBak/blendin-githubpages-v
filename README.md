# Undercover Tourist, GitHub Pages demo

This version of Undercover Tourist needs no server or database, so it can be published for free on GitHub Pages and shared as a link. The whole app runs in the visitor's browser: the GraphQL "server" from the other versions runs inside the page (`js/backend`), and everything is saved in the browser's localStorage.

That means:

- **Every visitor has their own copy.** Accounts, purchases, recommendations, votes and travel passes are saved only in the browser they were made in. Nobody else sees them, and clearing the browser's data deletes them.
- **Each visitor starts with the same demo content:** the six Dutch launch cities, their moderators and 21 recommendations.
- **Payments are a blueprint.** Choosing a bundle, trip pass or subscription unlocks it straight away and nothing is charged.
- **Visitors can try every role.** On the account page, "Demo tools" makes you a moderator of any city and resets all demo data. The account that signs up with `admin@example.com` (set in `js/config.js`) is the admin.

Use it to show the idea. For real users, use the Heroku version (still called Blend In), where data lives in MongoDB.

## Publish it on GitHub Pages

1. **Add your map key.** Open `js/config.js` and put your MapTiler key in `MAPTILER_KEY`. Anything in this file is visible to visitors, so in your MapTiler account restrict the key to your site's address (Account > API keys > the key > Allowed HTTP origins: `https://YOUR-USERNAME.github.io`).
2. **Create a repository.** On github.com, click New repository, give it a name such as `undercover-tourist`, make it Public, and create it.
3. **Upload the files.** In the new repository, click "uploading an existing file" (or Add file > Upload files) and drag in everything inside this folder: `index.html`, `.nojekyll` and the `css`, `data`, `js` and `vendor` folders. Upload the contents, not the zip file itself, and make sure `index.html` ends up at the top level. Click Commit changes.
4. **Switch on Pages.** Go to Settings > Pages. Under "Build and deployment", set Source to "Deploy from a branch", Branch to `main` and folder to `/ (root)`, then click Save.
5. **Open your link.** After a minute or two the page shows your address, usually `https://YOUR-USERNAME.github.io/undercover-tourist/`. Share that link.

To update the site later, upload the changed files again; GitHub Pages republishes automatically.

## Try it on your computer first

The site uses JavaScript modules, which browsers don't load from a double-clicked file, so open it through a small web server. In this folder run one of:

```
npx serve .
python -m http.server 8000
```

Then open the address it prints (for example http://localhost:8000).

## Maps and walking routes

- **Street maps** come from MapTiler using the key in `js/config.js`. Without a key the maps still work but show no streets, and the map says how to fix it. Another provider can be set with `TILE_URL` and `TILE_ATTRIBUTION`.
- **Walking routes** are requested straight from the browser: first OpenRouteService if you put a key in `ORS_API_KEY` (free at openrouteservice.org), then the public OpenStreetMap routing servers. When someone adds a walk, they click a start and a destination to get the shortest walking route, then click the route or any street to add invisible route points it must pass through. If no routing service answers, the editor says so and draws a dashed red line. The demo walks are re-routed along streets in the background on a visitor's first visit.

## Files

```
index.html             The page
js/config.js           Your settings: map key, routing key, admin email
js/app.js, js/*.js     The website (same as the other versions)
js/backend/schema.js   The in-browser GraphQL server and its rules
js/backend/db.js       The localStorage database
js/backend/algo.js     Ranking, personalisation, crowding and tier formulas
js/backend/routing.js  Walking routes
js/backend/seed.js     Dutch demo content
vendor/                D3, TopoJSON, Leaflet and GraphQL.js
data/countries.json    Country outlines for the globe and the travel pass
```

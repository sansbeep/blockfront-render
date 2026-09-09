# BLOCKFRONT server

Three files do everything: `server.js` serves the game and runs multiplayer (lobbies, co-op,
free-for-all, duels, accounts). `public/index.html` is the game itself. `package.json` lists
the one dependency (`ws`).

## Deploy on Render

1. Push this folder's contents to a **new GitHub repo** (root of the repo = these files directly,
   not inside a subfolder).
2. render.com → **New +** → **Web Service** → connect the repo.
3. Fill in the form exactly like this:
   - **Language**: **Node** (if Render shows anything else selected, change it manually — don't
     let it auto-pick Docker)
   - **Region**: Singapore
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: Free
   - **Health Check Path**: leave empty
4. Click **Deploy Web Service**. Wait for "Live".
5. Test `https://<your-service>.onrender.com/health` first — it should say `ok`.
6. Open the main URL, sign in, click **ENTER THE BRIEFING ROOM**.

## Updating the game later
Replace `public/index.html` in the repo with a newer version (upload → same filename), commit.
Render redeploys automatically. Replace `server.js` the same way if the multiplayer code changes.

## Playing
Sign in → **ENTER THE BRIEFING ROOM**. Walk into the glowing portal for Quick Play, or through a
door for a lobby your friends made (press **E**). Press **E** at the lockers/console for Armory/
Squad. Walk up to someone and press **F** to add them as a friend. Hold **TAB** in a match for
the scoreboard.

## Notes
- Free tier sleeps after ~15 min idle; first visitor after that waits 30–60s.
- Accounts (`users.json`) do **not** survive a redeploy on Render's free tier — fine for playing,
  just don't expect all-time stats to stick around forever on this tier.

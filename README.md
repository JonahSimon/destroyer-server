# destroyer-server

Reimplemented multiplayer server for **Destroyer**, a 3D naval combat game originally hosted on
shockwave.com. shockwave.com's backend is dead, so this is a from-scratch Node.js server (plus
three CPU bots) that lets the original, unmodified client play again, Skirmish vs AI. Built for the
[Flashpoint Archive](https://flashpointarchive.org/) curation of the game.

No original game code is in this repo. The protocol (login handshake, room/lobby flow, combat
message wire format) was reverse-engineered by observing the original client's network traffic and
reading its decompiled Lingo/AS2 output; only the server-side reimplementation is here.

## Running

```
npm install    # no deps currently, but future-proof
node server.js       # starts the TCP game server (:10101), an HTTP static server, and
                      # Flash socket-policy responders on :843 and :80
node bot.js           # starts three CPU bots (Easy/Normal/Hard), each waiting in its own room
```

Or on Windows, `launch.bat` starts both in separate console windows.

`main.js` is the single-process entry point used for the packaged Flashpoint build (bundles
server + bots into one process via `pkg`).

Env vars: `DESTROYER_PORT` (game TCP port, default 10101), `DESTROYER_HTTP` (static HTTP port,
default 8080, set to `0` for an ephemeral port), `DESTROYER_HOST` (force a fixed advertised
address instead of reflecting each client's own connect address, for NAT/port-forwarding).

## Tests

`test/testclient.js`, `test/test_match.js`, `test/test_watch.js`, `test/test_lan.js` are headless
protocol tests, no Flash/Shockwave client needed. Run the server first, then `node test/<file>`.

## License

MIT, see `LICENSE`.

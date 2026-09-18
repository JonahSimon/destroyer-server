// Single-exe entry: game server + Easy/Normal/Hard CPU bots in ONE process.
// Mirrors launch.bat (and OpenFusion's winfusion.exe) so a Flashpoint player needs no Node.
// pkg bundles server.js + bot.js from the literal requires below.
process.env.DESTROYER_HTTP = process.env.DESTROYER_HTTP || '0'; // ephemeral HTTP port: the dev launcher.html isn't used under Flashpoint; avoids an 8080 clash on the player's PC
process.argv = [process.argv[0], 'bot.js'];                     // no room arg -> bot.js starts all three bots
require('./server.js');                                         // binds TCP :10101 immediately
setTimeout(() => require('./bot.js'), 2000);                    // let the port bind, then connect the bots (they auto-reconnect anyway)

// Known game executables (process name, lowercase, no .exe) -> display name.
// Anything else running fullscreen also counts as a game unless it's on NOT_GAMES.
const KNOWN = {
  'fortniteclient-win64-shipping': 'Fortnite',
  'valorant-win64-shipping': 'Valorant',
  cs2: 'Counter-Strike 2', csgo: 'CS:GO',
  robloxplayerbeta: 'Roblox', robloxstudiobeta: 'Roblox Studio',
  gta5: 'GTA V', gta5_enhanced: 'GTA V', playgta5: 'GTA V', fivem: 'FiveM', 'fivem_b2944_gtaprocess': 'FiveM',
  'cod': 'Call of Duty', 'cod24-cod': 'Call of Duty', 'cod25-cod': 'Call of Duty', modernwarfare: 'Call of Duty', blackops6: 'Call of Duty',
  r5apex: 'Apex Legends', r5apex_dx12: 'Apex Legends',
  overwatch: 'Overwatch 2', rocketleague: 'Rocket League',
  'league of legends': 'League of Legends', dota2: 'Dota 2',
  'minecraft.windows': 'Minecraft', javaw: 'Minecraft', minecraftlauncher: 'Minecraft',
  rainbowsix: 'Rainbow Six Siege', rainbowsix_vulkan: 'Rainbow Six Siege', rainbowsix_be: 'Rainbow Six Siege',
  'eldenring': 'Elden Ring', 'cyberpunk2077': 'Cyberpunk 2077', 'rdr2': 'Red Dead Redemption 2',
  'tslgame': 'PUBG', 'destiny2': 'Destiny 2', 'marvel-win64-shipping': 'Marvel Rivals',
  'deadlock': 'Deadlock', 'palworld-win64-shipping': 'Palworld', 'helldivers2': 'Helldivers 2',
  'skate-win64-shipping': 'skate.', 'skate': 'skate.', 'fc27': 'EA Sports FC 27', 'fc26': 'EA Sports FC 26', 'fc25': 'EA Sports FC 25',
  'thefinals': 'The Finals', 'escapefromtarkov': 'Escape from Tarkov', 'rust': 'Rust', 'terraria': 'Terraria',
  'starfield': 'Starfield', 'bf2042': 'Battlefield 2042', 'bf6': 'Battlefield 6', 'warframe.x64': 'Warframe',
  'genshinimpact': 'Genshin Impact', 'zenlesszonezero': 'Zenless Zone Zero', 'starrail': 'Honkai: Star Rail',
  'hollow knight silksong': 'Hollow Knight: Silksong', 'brawlhalla': 'Brawlhalla', 'smite2': 'Smite 2',
  'among us': 'Among Us', 'fallguys_client_game': 'Fall Guys', 'phasmophobia': 'Phasmophobia',
  'lethal company': 'Lethal Company', 'repo': 'R.E.P.O.', 'peak': 'PEAK',
};

// Fullscreen apps that are not games.
const NOT_GAMES = new Set([
  'explorer', 'chrome', 'msedge', 'firefox', 'opera', 'brave', 'vivaldi', 'arc', 'code', 'devenv', 'discord', 'spotify',
  'vlc', 'mpc-hc64', 'mpc-be64', 'potplayermini64', 'wmplayer', 'applicationframehost', 'searchhost', 'startmenuexperiencehost',
  'shellexperiencehost', 'lockapp', 'textinputhost', 'replix', 'electron', 'obs64', 'medal', 'steamwebhelper', 'steam',
  'epicgameslauncher', 'battle.net', 'riotclientux', 'glyph', 'powerpnt', 'winword', 'excel', 'teams', 'ms-teams', 'zoom',
  'photoshop', 'premiere pro', 'resolve', 'blender', 'claude', 'windowsterminal', 'powershell', 'cmd', 'taskmgr', 'snippingtool',
]);

// Returns a display name if the foreground window looks like a game, else null.
function detectGame(fg, customGames = []) {
  if (!fg || !fg.exe) return null;
  const exe = fg.exe.toLowerCase();
  const custom = customGames.find((g) => g.exe.toLowerCase().replace(/\.exe$/, '') === exe);
  if (custom) return custom.name;
  if (KNOWN[exe]) return KNOWN[exe];
  if (fg.full && !NOT_GAMES.has(exe)) return cleanTitle(fg.title) || fg.exe;
  return null;
}

function cleanTitle(t) {
  return (t || '').replace(/\s+[-–|]\s+.*$/, '').trim().slice(0, 40);
}

// Safe for file names: "Call of Duty" -> "Call of Duty", "R.E.P.O." -> "R.E.P.O"
function fileSafe(name) {
  return name.replace(/[<>:"/\\|?*_]/g, ' ').replace(/\s+/g, ' ').trim().replace(/\.+$/, '') || 'Replix';
}

module.exports = { detectGame, fileSafe };

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const PORT = process.env.PORT || 3000;
const TICK_RATE = 30;
const DT = 1 / TICK_RATE;
const WORLD = { w: 3000, h: 3000 };

const app = express();
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => Math.random() * (b - a) + a;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const TAU = Math.PI * 2;

const rooms = new Map();

function makeId(prefix = "") {
  return prefix + Math.random().toString(36).slice(2, 9);
}

function getRoom(code = "PUBLIC") {
  if (!rooms.has(code)) rooms.set(code, createRoom(code));
  return rooms.get(code);
}

function createRoom(code) {
  return {
    code,
    players: new Map(),
    enemies: [],
    gems: [],
    bullets: [],
    enemyBullets: [],
    anvils: [],
    particles: [],
    time: 0,
    spawnTimer: 0,
    eliteTimer: 32,
    bossTimer: 150,
    bossCount: 0,
    leaderboard: [],
    nextEnemyId: 1,
    nextGemId: 1,
    nextBulletId: 1,
    nextAnvilId: 1,
  };
}

function defaultBuild() {
  return {
    weapons: { plasma: 1 },
    passives: {},
    evolved: {},
    level: 1,
    xp: 0,
    xpNeed: 8,
    damage: 22,
    fireRate: 0.48,
    bulletSpeed: 560,
    multishot: 1,
    lightning: 0,
    orbitals: 0,
    aura: 0,
    pulse: 0,
    area: 0,
    cooldown: 0,
    crit: 0,
    magnet: 95,
    regen: 0,
    speed: 265,
    maxHp: 100
  };
}

function createPlayer(ws, name) {
  const angle = rand(0, TAU);
  const radius = rand(0, 120);
  const build = defaultBuild();
  return {
    id: makeId("p_"),
    ws,
    name: String(name || "Player").slice(0, 16),
    x: WORLD.w / 2 + Math.cos(angle) * radius,
    y: WORLD.h / 2 + Math.sin(angle) * radius,
    r: 16,
    hp: 100,
    alive: true,
    input: { x: 0, y: 0 },
    score: 0,
    kills: 0,
    fireTimer: 0,
    pulseTimer: 0,
    auraTimer: 0,
    invuln: 0,
    build,
    pendingLevelUps: 0,
    pendingAnvil: false,
    lastSeen: Date.now()
  };
}

const upgradeDefs = {
  plasma:{type:"weapon", icon:"🔫", name:"Plasma Gun", max:6},
  orbit:{type:"weapon", icon:"🔥", name:"Fire Orbit", max:6},
  lightning:{type:"weapon", icon:"🔗", name:"Chain Lightning", max:6},
  aura:{type:"weapon", icon:"🟣", name:"Void Aura", max:6},
  pulse:{type:"weapon", icon:"💫", name:"Nova Pulse", max:6},
  speed:{type:"passive", icon:"🌀", name:"Shadow Boots", max:5},
  magnet:{type:"passive", icon:"🧲", name:"XP Magnet", max:5},
  tome:{type:"passive", icon:"📘", name:"Cooldown Tome", max:5},
  heart:{type:"passive", icon:"❤️", name:"Vital Core", max:5},
  focus:{type:"passive", icon:"🎯", name:"Crit Lens", max:5},
  area:{type:"passive", icon:"📡", name:"Area Amplifier", max:5}
};

const evolveRecipes = [
  {weapon:"plasma", passive:"focus", result:"deathRay", icon:"☄️", name:"EVOLVE: Death Ray"},
  {weapon:"orbit", passive:"area", result:"solarRing", icon:"☀️", name:"EVOLVE: Solar Ring"},
  {weapon:"lightning", passive:"tome", result:"stormCrown", icon:"👑", name:"EVOLVE: Storm Crown"},
  {weapon:"aura", passive:"heart", result:"bloodField", icon:"🩸", name:"EVOLVE: Blood Field"},
  {weapon:"pulse", passive:"magnet", result:"singularity", icon:"🕳️", name:"EVOLVE: Singularity"}
];

function getLevel(collection, id) {
  return collection[id] || 0;
}

function canEvolve(build, r) {
  return getLevel(build.weapons, r.weapon) >= 6 &&
         getLevel(build.passives, r.passive) >= 3 &&
         !build.evolved[r.result];
}

function makeChoices(player, anvil = false) {
  const build = player.build;
  let choices = [];

  for (const r of evolveRecipes) {
    if (canEvolve(build, r)) {
      choices.push({ kind:"evolve", id:r.result, icon:r.icon, name:r.name, recipe:r });
    }
  }

  if (anvil) {
    const bossRewards = [
      {kind:"forge", id:"forge_damage", icon:"⚔️", name:"Boss Forge: +45% Damage"},
      {kind:"forge", id:"forge_cooldown", icon:"⏱️", name:"Boss Forge: Hyper Cooldown"},
      {kind:"forge", id:"forge_area", icon:"🌌", name:"Boss Forge: Area Surge"},
      {kind:"forge", id:"forge_xp", icon:"💎", name:"Boss Forge: XP Vacuum"},
      {kind:"forge", id:"forge_survival", icon:"🛡️", name:"Boss Forge: Survival Core"}
    ];
    choices = choices.concat(bossRewards.sort(() => Math.random() - 0.5));
    return choices.slice(0, 3);
  }

  for (const [id, def] of Object.entries(upgradeDefs)) {
    const current = def.type === "weapon" ? getLevel(build.weapons, id) : getLevel(build.passives, id);
    if (current < def.max) {
      choices.push({
        kind:"upgrade",
        id,
        icon:def.icon,
        name: current === 0 ? `Unlock: ${def.name}` : `${def.name} Lv.${current + 1}`,
        type:def.type,
        level:current + 1
      });
    }
  }

  choices.sort((a,b) => {
    if(a.kind === "evolve" && b.kind !== "evolve") return -1;
    if(a.kind !== "evolve" && b.kind === "evolve") return 1;
    return Math.random() - 0.5;
  });

  return choices.slice(0, 3);
}

function applyChoice(player, choice) {
  if (!player || !choice || !player.alive) return;
  const b = player.build;

  if (choice.kind === "evolve") {
    const recipe = evolveRecipes.find(r => r.result === choice.id);
    if (!recipe || !canEvolve(b, recipe)) return;
    b.evolved[recipe.result] = true;

    if(recipe.result === "deathRay"){ b.damage *= 1.8; b.fireRate *= .78; b.multishot += 1; }
    if(recipe.result === "solarRing"){ b.orbitals += 3; b.area += .45; }
    if(recipe.result === "stormCrown"){ b.lightning += 4; b.cooldown += .18; b.fireRate *= .88; }
    if(recipe.result === "bloodField"){ b.aura += 3; b.area += .35; b.regen += 1.6; }
    if(recipe.result === "singularity"){ b.pulse += 3; b.magnet += 120; b.area += .35; }
    return;
  }

  if (choice.kind === "forge") {
    if(choice.id === "forge_damage") b.damage *= 1.45;
    if(choice.id === "forge_cooldown"){ b.fireRate *= .72; b.cooldown += .18; }
    if(choice.id === "forge_area") b.area += .35;
    if(choice.id === "forge_xp"){ b.magnet += 180; gainXp(player, Math.ceil(b.xpNeed*.55)); }
    if(choice.id === "forge_survival"){ b.maxHp += 45; player.hp = Math.min(b.maxHp, player.hp + 70); b.regen += 1.1; }
    return;
  }

  const def = upgradeDefs[choice.id];
  if (!def) return;

  if(def.type === "weapon"){
    const lv = b.weapons[choice.id] || 0;
    if(lv >= def.max) return;
    b.weapons[choice.id] = lv + 1;

    if(choice.id === "plasma"){
      b.damage *= 1.20;
      b.fireRate *= .93;
      if(b.weapons[choice.id] === 3) b.multishot += 1;
      if(b.weapons[choice.id] === 5) b.bulletSpeed += 80;
    }
    if(choice.id === "orbit") b.orbitals += 1;
    if(choice.id === "lightning") b.lightning += 1;
    if(choice.id === "aura") b.aura += 1;
    if(choice.id === "pulse") b.pulse += 1;
  }

  if(def.type === "passive"){
    const lv = b.passives[choice.id] || 0;
    if(lv >= def.max) return;
    b.passives[choice.id] = lv + 1;

    if(choice.id === "speed") b.speed *= 1.13;
    if(choice.id === "magnet") b.magnet += 70;
    if(choice.id === "tome"){ b.cooldown += .08; b.fireRate *= .92; }
    if(choice.id === "heart"){ b.maxHp += 22; player.hp = Math.min(b.maxHp, player.hp + 30); b.regen += .45; }
    if(choice.id === "focus"){ b.crit += .08; b.damage *= 1.08; }
    if(choice.id === "area") b.area += .12;
  }
}

function gainXp(player, amount) {
  const b = player.build;
  b.xp += amount;
  player.score += amount * 2;

  while (b.xp >= b.xpNeed) {
    b.xp -= b.xpNeed;
    b.level += 1;
    b.xpNeed = Math.floor(b.xpNeed * 1.24 + 6);
    player.pendingLevelUps += 1;
  }
}

function spawnEnemy(room, type = "normal", x = null, y = null) {
  if (x === null || y === null) {
    const target = nearestAlivePlayer(room) || { x: WORLD.w/2, y: WORLD.h/2 };
    const angle = rand(0, TAU);
    const radius = rand(650, 900);
    x = clamp(target.x + Math.cos(angle) * radius, 20, WORLD.w - 20);
    y = clamp(target.y + Math.sin(angle) * radius, 20, WORLD.h - 20);
  }

  const t = room.time;
  const scale = 1 + t / 120;
  const data = {
    normal:{r:13,hp:34*scale,speed:54+Math.min(48,t*.22),dmg:11,color:"#ff3df2",xp:4,score:10},
    fast:{r:10,hp:20*scale,speed:92+Math.min(58,t*.28),dmg:9,color:"#36e8ff",xp:3,score:14},
    tank:{r:20,hp:92*scale,speed:36+Math.min(34,t*.13),dmg:19,color:"#ffe45c",xp:9,score:34},
    elite:{r:24,hp:185*scale,speed:48+Math.min(42,t*.16),dmg:24,color:"#52ff9a",xp:18,score:85},
    boss:{r:48,hp:(1800 + room.bossCount*650)*(1+t/155),speed:24+Math.min(20,t*.035),dmg:44,color:"#ff355d",xp:80,score:800},
    bossTank:{r:58,hp:(2900 + room.bossCount*900)*(1+t/145),speed:18+Math.min(16,t*.025),dmg:55,color:"#ffe45c",xp:95,score:1000},
    bossDash:{r:44,hp:(2200 + room.bossCount*720)*(1+t/150),speed:34+Math.min(25,t*.045),dmg:48,color:"#36e8ff",xp:90,score:950},
    bossSummoner:{r:52,hp:(2450 + room.bossCount*780)*(1+t/150),speed:22+Math.min(18,t*.032),dmg:42,color:"#a340ff",xp:105,score:1100}
  }[type];

  room.enemies.push({
    id: room.nextEnemyId++,
    x,y,type,
    r:data.r,
    hp:data.hp,
    maxHp:data.hp,
    speed:data.speed,
    dmg:data.dmg,
    color:data.color,
    xp:data.xp,
    score:data.score,
    hit:0,
    angle:rand(0,TAU),
    specialTimer: type.startsWith("boss") ? rand(1.4,2.6) : 0,
    dashTimer: type === "bossDash" ? rand(1.8,2.8) : 0,
    dashBurst: 0
  });
}

function spawnBoss(room) {
  room.bossCount += 1;
  const cycle = ["boss", "bossDash", "bossTank", "bossSummoner"];
  const type = cycle[(room.bossCount - 1) % cycle.length];
  spawnEnemy(room, type);
  broadcast(room, { type:"event", event:"boss", boss:type });
}

function spawnGem(room, x, y, value) {
  room.gems.push({
    id: room.nextGemId++,
    x,y,
    r:6 + Math.min(8, value/12),
    value,
    vx:rand(-30,30),
    vy:rand(-30,30)
  });
}

function spawnAnvil(room, x, y) {
  room.anvils.push({ id: room.nextAnvilId++, x, y, r:17 });
  broadcast(room, { type:"event", event:"anvil" });
}

function nearestAlivePlayer(room, from = null) {
  let best = null, bestD = Infinity;
  for (const p of room.players.values()) {
    if (!p.alive) continue;
    if (!from) return p;
    const d = dist(p, from);
    if (d < bestD) { best = p; bestD = d; }
  }
  return best;
}

function nearestEnemy(room, player) {
  let best = null, bestD = Infinity;
  for (const e of room.enemies) {
    const d = dist(e, player);
    if (d < bestD) { best = e; bestD = d; }
  }
  return best;
}

function shoot(room, player) {
  const target = nearestEnemy(room, player);
  if (!target) return false;
  const b = player.build;
  const base = Math.atan2(target.y - player.y, target.x - player.x);
  const count = b.multishot;
  const spread = Math.min(.72, .16*(count-1));

  for(let i=0;i<count;i++){
    const offset = count === 1 ? 0 : -spread/2 + spread * (i/(count-1));
    const a = base + offset;
    room.bullets.push({
      id: room.nextBulletId++,
      ownerId: player.id,
      x:player.x,
      y:player.y,
      vx:Math.cos(a)*b.bulletSpeed,
      vy:Math.sin(a)*b.bulletSpeed,
      r:5,
      dmg:b.damage * (Math.random() < b.crit ? 2.4 : 1),
      life:b.evolved.deathRay ? 2.1 : 1.55,
      pierce:b.evolved.deathRay ? 3 : 0,
      color:b.evolved.deathRay ? "#ffe45c" : "#36e8ff"
    });
  }
  return true;
}

function damageEnemy(room, enemy, dmg, ownerId, color = "#36e8ff") {
  enemy.hp -= dmg;
  enemy.hit = .08;

  const owner = room.players.get(ownerId);

  if(owner && owner.build.lightning > 0 && Math.random() < (owner.build.evolved.stormCrown ? .72 : .18 + owner.build.lightning*.04)){
    let arcs = Math.min(1 + owner.build.lightning + (owner.build.evolved.stormCrown ? 4 : 0), owner.build.evolved.stormCrown ? 10 : 4);
    let current = enemy;
    const chained = new Set([enemy.id]);
    while(arcs-- > 0){
      let next = null, bestD = 155;
      for(const other of room.enemies){
        if(chained.has(other.id)) continue;
        const d = dist(other, current);
        if(d < bestD){ next = other; bestD = d; }
      }
      if(!next) break;
      next.hp -= dmg * .42;
      next.hit = .08;
      chained.add(next.id);
      current = next;
    }
  }

  if (enemy.hp <= 0) killEnemy(room, enemy, ownerId);
}

function killEnemy(room, enemy, ownerId) {
  const i = room.enemies.indexOf(enemy);
  if (i >= 0) room.enemies.splice(i, 1);

  const owner = room.players.get(ownerId);
  if (owner) {
    owner.kills += 1;
    owner.score += enemy.score;
  }

  spawnGem(room, enemy.x, enemy.y, enemy.xp);

  if (enemy.type && enemy.type.startsWith("boss")) {
    spawnAnvil(room, enemy.x, enemy.y);
  }
}

function updateRoom(room) {
  room.time += DT;
  room.spawnTimer -= DT;
  room.eliteTimer -= DT;
  room.bossTimer -= DT;

  const players = [...room.players.values()].filter(p => p.alive);

  if (players.length === 0) return;

  const difficulty = 1 + room.time / 120;
  if(room.spawnTimer <= 0){
    const wave = Math.min(6, Math.floor(1 + difficulty * .72));
    for(let i=0;i<wave;i++){
      const roll = Math.random();
      let type = "normal";
      if(room.time > 45 && roll < .16) type = "fast";
      if(room.time > 85 && roll > .88) type = "tank";
      spawnEnemy(room, type);
    }
    room.spawnTimer = Math.max(.62, 1.85 - room.time*.0032);
  }

  if(room.eliteTimer <= 0){
    spawnEnemy(room, "elite");
    room.eliteTimer = Math.max(16, 36 - room.time*.025);
  }

  if(room.bossTimer <= 0){
    spawnBoss(room);
    room.bossTimer = Math.max(85, 150 - room.bossCount * 8);
  }

  for (const p of players) {
    const b = p.build;
    p.x = clamp(p.x + p.input.x * b.speed * DT, p.r, WORLD.w - p.r);
    p.y = clamp(p.y + p.input.y * b.speed * DT, p.r, WORLD.h - p.r);

    if (b.regen > 0) p.hp = Math.min(b.maxHp, p.hp + b.regen * DT);
    p.invuln = Math.max(0, p.invuln - DT);

    p.fireTimer -= DT;
    if (p.fireTimer <= 0) {
      const didShoot = shoot(room, p);
      p.fireTimer = didShoot ? b.fireRate : 0.04;
    }

    if (b.orbitals > 0) {
      const orbitalRadius = 48 + b.orbitals * 5;
      for(let i=0;i<b.orbitals;i++){
        const a = room.time * (2.7 + b.orbitals*.13) + i * TAU/b.orbitals;
        const ox = p.x + Math.cos(a)*orbitalRadius;
        const oy = p.y + Math.sin(a)*orbitalRadius;
        const hitRadius = 12 * (1 + b.area);
        for (const e of [...room.enemies]) {
          if(Math.hypot(e.x-ox,e.y-oy) < e.r + hitRadius){
            damageEnemy(room, e, (16 + b.damage*.22) * DT * (b.evolved.solarRing ? 9.2 : 5.4), p.id, b.evolved.solarRing ? "#ffe45c" : "#ff8a3d");
          }
        }
      }
    }

    if (b.aura > 0) {
      const auraRadius = (82 + b.aura * 18) * (1 + b.area);
      const auraDps = (9 + b.aura * 7 + b.damage * .08) * (b.evolved.bloodField ? 1.65 : 1);
      for (const e of [...room.enemies]) {
        if (dist(e, p) < auraRadius + e.r) {
          damageEnemy(room, e, auraDps * DT, p.id, b.evolved.bloodField ? "#ff355d" : "#a340ff");
          if (b.evolved.bloodField) p.hp = Math.min(b.maxHp, p.hp + .35 * DT);
        }
      }
    }

    if (b.pulse > 0) {
      p.pulseTimer -= DT;
      const pulseCd = Math.max(.85, 3.2 - b.pulse*.28 - b.cooldown);
      if (p.pulseTimer <= 0) {
        const radius = (120 + b.pulse * 25) * (1 + b.area);
        const dmg = 44 + b.pulse * 22 + b.damage * .35;
        for (const e of [...room.enemies]) {
          const d = dist(e, p);
          if (d < radius + e.r) {
            damageEnemy(room, e, dmg, p.id, b.evolved.singularity ? "#111111" : "#36e8ff");
            if (b.evolved.singularity && d > 8) {
              const a = Math.atan2(p.y-e.y, p.x-e.x);
              e.x += Math.cos(a) * Math.min(90, radius-d) * .35;
              e.y += Math.sin(a) * Math.min(90, radius-d) * .35;
            }
          }
        }
        p.pulseTimer = pulseCd;
      }
    }
  }

  for (const b of [...room.bullets]) {
    b.x += b.vx * DT;
    b.y += b.vy * DT;
    b.life -= DT;

    if (b.life <= 0 || b.x < -80 || b.y < -80 || b.x > WORLD.w + 80 || b.y > WORLD.h + 80) {
      room.bullets.splice(room.bullets.indexOf(b), 1);
      continue;
    }

    for (const e of [...room.enemies]) {
      if (dist(b, e) < b.r + e.r) {
        damageEnemy(room, e, b.dmg, b.ownerId, b.color);
        b.pierce -= 1;
        if (b.pierce < 0) {
          room.bullets.splice(room.bullets.indexOf(b), 1);
          break;
        }
      }
    }
  }

  for (const e of [...room.enemies]) {
    const target = nearestAlivePlayer(room, e);
    if (!target) continue;

    const a = Math.atan2(target.y - e.y, target.x - e.x);
    const wobble = Math.sin(room.time*3 + e.angle) * .28;
    let speedMul = 1;

    if (e.type === "bossDash") {
      e.dashTimer -= DT;
      if (e.dashTimer <= 0 && e.dashBurst <= 0) {
        e.dashBurst = .55;
        e.dashTimer = rand(3.0, 4.2);
      }
      if (e.dashBurst > 0) {
        e.dashBurst -= DT;
        speedMul = 4.2;
      }
    }

    e.x = clamp(e.x + Math.cos(a+wobble) * e.speed * speedMul * DT, e.r, WORLD.w-e.r);
    e.y = clamp(e.y + Math.sin(a+wobble) * e.speed * speedMul * DT, e.r, WORLD.h-e.r);

    if (e.type && e.type.startsWith("boss")) {
      e.specialTimer -= DT;
      if (e.specialTimer <= 0) {
        if (e.type === "boss" || e.type === "bossTank") {
          const shots = e.type === "bossTank" ? 14 : 10;
          for (let i=0; i<shots; i++) {
            const ba = i * TAU / shots + room.time*.4;
            room.enemyBullets.push({x:e.x,y:e.y,vx:Math.cos(ba)*150,vy:Math.sin(ba)*150,r:6,dmg:e.type==="bossTank"?16:12,life:4,color:e.color});
          }
        }
        if (e.type === "bossSummoner") {
          for (let i=0; i<5 + Math.min(7, room.bossCount); i++) spawnEnemy(room, Math.random()<.35 ? "fast" : "normal");
        }
        if (e.type === "bossDash") {
          const ba = Math.atan2(target.y-e.y, target.x-e.x);
          for (let i=-2; i<=2; i++) {
            const aa = ba + i*.18;
            room.enemyBullets.push({x:e.x,y:e.y,vx:Math.cos(aa)*235,vy:Math.sin(aa)*235,r:5,dmg:13,life:3.2,color:e.color});
          }
        }
        e.specialTimer = Math.max(1.4, 3.4 - room.bossCount*.12);
      }
    }

    if (dist(e, target) < e.r + target.r && target.invuln <= 0) {
      target.hp -= e.dmg;
      target.invuln = .42;
      if (target.hp <= 0) {
        target.hp = 0;
        target.alive = false;
        broadcast(room, { type:"event", event:"death", playerId:target.id, name:target.name });
      }
    }
  }

  for (const eb of [...room.enemyBullets]) {
    eb.x += eb.vx * DT;
    eb.y += eb.vy * DT;
    eb.life -= DT;
    if (eb.life <= 0 || eb.x < -80 || eb.y < -80 || eb.x > WORLD.w+80 || eb.y > WORLD.h+80) {
      room.enemyBullets.splice(room.enemyBullets.indexOf(eb),1);
      continue;
    }

    for (const p of players) {
      if (p.invuln <= 0 && dist(eb, p) < eb.r + p.r) {
        p.hp -= eb.dmg;
        p.invuln = .28;
        room.enemyBullets.splice(room.enemyBullets.indexOf(eb),1);
        if (p.hp <= 0) {
          p.hp = 0;
          p.alive = false;
          broadcast(room, { type:"event", event:"death", playerId:p.id, name:p.name });
        }
        break;
      }
    }
  }

  for (const g of [...room.gems]) {
    g.x += g.vx * DT;
    g.y += g.vy * DT;
    g.vx *= Math.pow(.06, DT);
    g.vy *= Math.pow(.06, DT);

    for (const p of players) {
      const d = dist(g, p);
      if (d < p.build.magnet) {
        const a = Math.atan2(p.y - g.y, p.x - g.x);
        const pull = 360 + (p.build.magnet - d) * 6;
        g.x += Math.cos(a) * pull * DT;
        g.y += Math.sin(a) * pull * DT;
      }
      if (d < p.r + g.r + 4) {
        gainXp(p, g.value);
        room.gems.splice(room.gems.indexOf(g), 1);
        break;
      }
    }
  }

  for (const anvil of [...room.anvils]) {
    for (const p of players) {
      if (dist(anvil, p) < p.r + anvil.r + 10) {
        room.anvils.splice(room.anvils.indexOf(anvil), 1);
        p.pendingAnvil = true;
        sendTo(p, { type:"choices", anvil:true, choices:makeChoices(p, true) });
        break;
      }
    }
  }

  const enemyCap = players.length > 1 ? 230 : 180;
  if (room.enemies.length > enemyCap) {
    room.enemies.sort((a,b) => {
      const pa = nearestAlivePlayer(room, a);
      const pb = nearestAlivePlayer(room, b);
      return (pb ? dist(b, pb) : 0) - (pa ? dist(a, pa) : 0);
    });
    const removeCount = Math.min(room.enemies.length - enemyCap, 18);
    for (let i=0; i<removeCount; i++) {
      const e = room.enemies.shift();
      if (!e || e.type.startsWith("boss")) continue;
      if (Math.random() < .35) spawnGem(room, e.x, e.y, Math.max(1, Math.floor(e.xp*.55)));
    }
  }

  for (const p of players) {
    if (p.pendingLevelUps > 0 && !p.pendingAnvil) {
      sendTo(p, { type:"choices", anvil:false, choices:makeChoices(p, false) });
      p.pendingLevelUps -= 1;
    }
  }

  room.leaderboard = [...room.players.values()]
    .map(p => ({ id:p.id, name:p.name, score:Math.floor(p.score), kills:p.kills, level:p.build.level, alive:p.alive }))
    .sort((a,b) => b.score - a.score)
    .slice(0, 8);
}

function snapshot(room) {
  return {
    type:"state",
    world:WORLD,
    time:room.time,
    bossTimer:room.bossTimer,
    bossCount:room.bossCount,
    players:[...room.players.values()].map(p => ({
      id:p.id,name:p.name,x:p.x,y:p.y,r:p.r,hp:p.hp,maxHp:p.build.maxHp,alive:p.alive,
      score:Math.floor(p.score),kills:p.kills,level:p.build.level,xp:p.build.xp,xpNeed:p.build.xpNeed,
      orbitals:p.build.orbitals,aura:p.build.aura,pulse:p.build.pulse,area:p.build.area,evolved:p.build.evolved,
      weapons:p.build.weapons,passives:p.build.passives
    })),
    enemies:room.enemies.map(e => ({id:e.id,x:e.x,y:e.y,r:e.r,hp:e.hp,maxHp:e.maxHp,type:e.type,color:e.color})),
    bullets:room.bullets.map(b => ({x:b.x,y:b.y,r:b.r,color:b.color})),
    enemyBullets:room.enemyBullets.map(b => ({x:b.x,y:b.y,r:b.r,color:b.color})),
    gems:room.gems.map(g => ({id:g.id,x:g.x,y:g.y,r:g.r,value:g.value})),
    anvils:room.anvils.map(a => ({id:a.id,x:a.x,y:a.y,r:a.r})),
    leaderboard:room.leaderboard
  };
}

function sendTo(player, payload) {
  if (player.ws.readyState === WebSocket.OPEN) {
    player.ws.send(JSON.stringify(payload));
  }
}

function broadcast(room, payload) {
  const msg = JSON.stringify(payload);
  for (const p of room.players.values()) {
    if (p.ws.readyState === WebSocket.OPEN) p.ws.send(msg);
  }
}

wss.on("connection", (ws) => {
  let room = null;
  let player = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "join") {
      const code = String(msg.room || "PUBLIC").trim().slice(0, 16).toUpperCase() || "PUBLIC";
      room = getRoom(code);
      player = createPlayer(ws, msg.name);
      room.players.set(player.id, player);

      sendTo(player, { type:"init", id:player.id, room:code, world:WORLD });
      broadcast(room, { type:"event", event:"join", name:player.name });
      return;
    }

    if (!room || !player) return;
    player.lastSeen = Date.now();

    if (msg.type === "input") {
      const x = Number(msg.x) || 0;
      const y = Number(msg.y) || 0;
      const l = Math.hypot(x, y);
      player.input.x = l > 1 ? x / l : x;
      player.input.y = l > 1 ? y / l : y;
    }

    if (msg.type === "choose") {
      applyChoice(player, msg.choice);
      if (player.pendingAnvil) player.pendingAnvil = false;
    }

    if (msg.type === "revive") {
      if (!player.alive && player.score >= 100) {
        player.score -= 100;
        player.hp = Math.ceil(player.build.maxHp * 0.55);
        player.alive = true;
        player.x = WORLD.w / 2 + rand(-120, 120);
        player.y = WORLD.h / 2 + rand(-120, 120);
      }
    }
  });

  ws.on("close", () => {
    if (room && player) {
      room.players.delete(player.id);
      broadcast(room, { type:"event", event:"leave", name:player.name });
      if (room.players.size === 0 && room.code !== "PUBLIC") rooms.delete(room.code);
    }
  });
});

setInterval(() => {
  for (const room of rooms.values()) {
    updateRoom(room);
    const snap = JSON.stringify(snapshot(room));
    for (const p of room.players.values()) {
      if (p.ws.readyState === WebSocket.OPEN) p.ws.send(snap);
    }
  }
}, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log(`Neon Swarm Online running on http://localhost:${PORT}`);
});

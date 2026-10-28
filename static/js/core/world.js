import { BOT_COLORS, BOT_NAMES, CONFIG, FOOD_COLORS } from "../config.js";
import { canEat, createBall, distanceSquared, growBall, moveBall } from "./entities.js";
import { BOT_SKILLS, chooseBotDirection, chooseBotSplit } from "./ai.js";
import { BOT_ROLES, getDifficulty, getStage, outsideView, roleForIndex } from "./progression.js";
import { Sprint } from "./sprint.js";
import { clampCell, splitCells, SplitAbility, summarizeCells, updateCellGroup } from "./cells.js";
import { FoodHotspots } from "./hotspots.js";
import { findRespawnPosition, SurvivalRound } from "./survival.js";
import { consumeSpores, createSpore, updateSpores } from "./spores.js";
import { collidesWithSpike, createSpikes, feedSpikes, updateSpikes } from "./spikes.js";
import { SpatialGrid } from "./spatial-grid.js";
import { RoundStats } from "./round-stats.js";
import { PracticeCourse } from "./practice.js";

/** 纯游戏状态与规则，不访问 DOM、Canvas、网络和数据库。 */
export class World {
  constructor(random = Math.random) {
    this.random = random;
    this.bounds = { ...CONFIG.world };
    this.reset();
  }

  reset(viewSize = { width: 900, height: 650 }, mode = "classic", drill = "split") {
    this.mode = ["survival", "practice"].includes(mode) ? mode : "classic";
    this.survival = this.mode === "survival" ? new SurvivalRound() : null;
    this.practice = this.mode === "practice" ? new PracticeCourse(drill) : null;
    this.stats = new RoundStats();
    this.regrouping = false;
    this.botDifficulty = "standard";
    this.result = null;
    this.nextId = 0;
    this.elapsed = 0;
    this.score = 0;
    this.eatenBalls = 0;
    this.foodsEaten = 0;
    this.gameOver = false;
    this.killer = "";
    this.events = [];
    this.refillTimer = 0;
    this.respawnTimer = 0;
    this.difficultyTimer = 0;
    this.peakMass = CONFIG.player.initialMass;
    this.sprint = new Sprint();
    this.split = new SplitAbility();
    this.sporeCooldown = 0;
    this.sporeWasPressed = false;
    this.spores = [];
    this.ballGrid = new SpatialGrid(CONFIG.spatial.cellSize);
    this.foodGrid = new SpatialGrid(CONFIG.spatial.cellSize);
    this.sporeGrid = new SpatialGrid(CONFIG.spatial.cellSize);
    this.spikeGrid = new SpatialGrid(CONFIG.spatial.cellSize);
    this.botSplitCooldowns = new Map();
    this.stage = getStage(0);
    this.difficulty = getDifficulty(0, this.peakMass, 0);
    this.view = {
      left: (this.bounds.width - viewSize.width) / 2, right: (this.bounds.width + viewSize.width) / 2,
      top: (this.bounds.height - viewSize.height) / 2, bottom: (this.bounds.height + viewSize.height) / 2,
    };
    this.lastPlayer = createBall({
      id: "player", x: this.bounds.width / 2, y: this.bounds.height / 2,
      mass: CONFIG.player.initialMass, name: "你", color: "#b4efcc", isPlayer: true,
    });
    this.playerCells = [this.lastPlayer];
    this.survival?.register(this.lastPlayer);
    this.hotspots = new FoodHotspots(this.bounds, this.random);
    this.foods = Array.from({ length: CONFIG.food.count }, () => this.createFood());
    this.bots = [];
    for (let i = 0; i < CONFIG.bots.count; i++) {
      const bot = this.createBot(i, roleForIndex(i));
      if (bot) {
        this.bots.push(bot);
        this.survival?.register(bot);
      }
    }
    this.spikes = createSpikes(this.bounds, this.random, [this.lastPlayer, ...this.bots]);
    this.spikeGrid.build(this.spikes);
    if (this.practice) this.practice.setup(this);
    this.stats.observe(this.playerCells);
    this.stats.sample(0, this.playerCells, true);
  }

  get protectionRemaining() {
    if (this.practice) return 0;
    if (this.survival) return this.survival.protection("player", this.elapsed);
    return Math.max(0, CONFIG.player.protectionSeconds - this.elapsed);
  }

  isProtected(ball) {
    if (this.practice) return false;
    return this.survival ? this.survival.protection(ball.ownerId, this.elapsed) > 0 :
      ball.isPlayer && this.protectionRemaining > 0;
  }

  // 保留主球引用供调试；业务判断使用 playerCells，镜头和 HUD 使用球群摘要。
  get player() {
    return this.playerCells.reduce((largest, cell) => !largest || cell.mass > largest.mass ? cell : largest, null) ?? this.lastPlayer;
  }

  get playerGroup() {
    return summarizeCells(this.playerCells, this.lastPlayer);
  }

  get botGroups() {
    const groups = new Map();
    for (const bot of this.bots) {
      if (!groups.has(bot.ownerId)) groups.set(bot.ownerId, []);
      groups.get(bot.ownerId).push(bot);
    }
    return groups;
  }

  getSporeSnapshot() {
    const source = this.playerCells.filter(cell => cell.alive).sort((a, b) => b.mass - a.mass)[0];
    const affordable = Boolean(source && source.mass >= CONFIG.spore.minimumMass);
    return { count: this.spores.length, maxCount: CONFIG.spore.maxCount, affordable,
      cooldown: this.sporeCooldown, ready: affordable && this.sporeCooldown === 0 && this.spores.length < CONFIG.spore.maxCount,
      progress: this.sporeCooldown === 0 ? 1 : 1 - this.sporeCooldown / CONFIG.spore.cooldown };
  }

  createFood() {
    return {
      id: `food-${this.nextId++}`,
      ...this.hotspots.sampleFoodPosition(),
      radius: CONFIG.food.radius,
      color: FOOD_COLORS[Math.floor(this.random() * FOOD_COLORS.length)],
    };
  }

  createBot(index, role = roleForIndex(index)) {
    const profile = BOT_ROLES[role];
    const reference = this.difficulty.referenceMass;
    const pressure = role === "hunter" ? this.difficulty.pressure : 1;
    const mass = this.survival ? CONFIG.player.initialMass :
      reference * (profile.minRatio + this.random() * (profile.maxRatio - profile.minRatio)) * pressure;
    const radius = Math.sqrt(mass) * CONFIG.rules.radiusScale;
    // 出生点远离玩家，重生时也不允许直接出现在玩家身上。
    let position = null;
    if (this.survival) position = findRespawnPosition(this.bounds, mass, [...this.playerCells, ...this.bots], this.random);
    for (let attempt = 0; !position && attempt < 120; attempt++) {
      const candidate = {
        x: radius + this.random() * (this.bounds.width - radius * 2),
        y: radius + this.random() * (this.bounds.height - radius * 2), radius,
      };
      if (!outsideView(candidate, this.view)) continue;
      if (this.playerCells.some(cell => distanceSquared(candidate, cell) <= (cell.radius + radius + 330) ** 2)) continue;
      if (this.bots.some(other => distanceSquared(candidate, other) < (radius + other.radius + 30) ** 2)) continue;
      position = candidate;
      break;
    }
    // 地图或视野太拥挤时延后刷新，不使用最后一次未通过检查的位置。
    if (!position) return null;
    const bot = createBall({
      id: `bot-${this.nextId++}`, x: position.x, y: position.y, mass,
      name: BOT_NAMES[index % BOT_NAMES.length], color: BOT_COLORS[index % BOT_COLORS.length],
    });
    bot.thinkTimer = this.random() * CONFIG.bots.thinkInterval;
    bot.role = role;
    return bot;
  }

  update(dt, input) {
    this.events = [];
    if (this.gameOver) return;
    if (input.view) this.view = input.view;
    // 到点先封盘，不在第 300 秒之后移动、吞噬或增加生命；暂停由 Session 冻结模拟时钟。
    if (this.survival && this.elapsed + dt >= this.survival.duration - 1e-8) {
      this.stats.advance(Math.max(0, this.survival.duration - this.elapsed));
      this.elapsed = this.survival.duration;
      this.finishSurvival("timeout");
      return;
    }
    this.elapsed += dt;
    this.stats.advance(dt);
    this.sporeCooldown = Math.max(0, this.sporeCooldown - dt);
    for (const ball of [...this.playerCells, ...this.bots]) ball.spikeCooldown = Math.max(0, ball.spikeCooldown - dt);
    // 记录本帧更新前的质量峰值；吐孢子和扎刺会改变当前质量，但不会让阶段倒退。
    this.peakMass = Math.max(this.peakMass, this.playerGroup.mass);
    const direction = this.sprint.update(dt, input, this.playerCells);
    if (this.sprint.started) this.events.push({ type: "sprint", x: this.player.x, y: this.player.y, color: this.player.color });
    const children = this.split.update(dt, { ...input, x: direction.x, y: direction.y },
      this.playerCells, this.bounds, () => `player-${this.nextId++}`);
    for (const child of children) this.events.push({ type: "split", x: child.x, y: child.y, color: child.color });
    this.regrouping = Boolean(input.regroup && this.playerCells.length > 1);
    const movementTarget = this.regrouping ? this.playerGroup : input.target;
    for (const cell of this.playerCells) {
      let cellDirection = direction;
      // 鼠标输入传递世界坐标目标，各分身分别朝同一位置移动；键盘保留平行操控。
      if (movementTarget && !this.sprint.remaining) {
        const dx = movementTarget.x - cell.x;
        const dy = movementTarget.y - cell.y;
        const length = Math.hypot(dx, dy);
        const strength = Math.min(1, Math.max(0, (length - 5) / 75));
        cellDirection = length > 0 ? { x: dx / length * strength, y: dy / length * strength } : { x: 0, y: 0 };
      }
      moveBall(cell, cellDirection, dt, this.bounds, this.sprint.remaining > 0 ? CONFIG.sprint.multiplier : 1);
    }

    if (!this.practice) this.updateBotSplits(dt);
    for (const bot of this.bots) {
      bot.thinkTimer -= dt;
      if (!this.practice && bot.thinkTimer <= 0) {
        bot.direction = chooseBotDirection(bot, this);
        bot.thinkTimer = BOT_SKILLS[this.botDifficulty].reaction + this.random() * 0.1;
      }
      moveBall(bot, bot.direction, dt, this.bounds);
    }

    const sporePressed = Boolean(input.spore);
    if (((sporePressed && !this.sporeWasPressed) || input.sporeHeld) && this.sporeCooldown === 0) this.emitSpore(input);
    this.sporeWasPressed = sporePressed;
    this.spores = updateSpores(this.spores, dt, this.bounds);
    this.spikes = updateSpikes(this.spikes, dt, this.bounds);
    this.events.push(...feedSpikes(this.spikes, this.spores, this.bounds, () => `launched-spike-${this.nextId++}`));
    this.spores = this.spores.filter(spore => spore.alive);
    this.handleSpikes(input);

    const sporeBalls = [...this.playerCells, ...this.bots];
    this.ballGrid.build(sporeBalls);
    this.sporeGrid.build(this.spores);
    const sporeResult = consumeSpores(this.spores, sporeBalls, this.ballGrid);
    this.spores = sporeResult.spores;
    for (const { spore, eater } of sporeResult.consumed) {
      if (eater.isPlayer) this.events.push({ type: "spore-eat", x: spore.x, y: spore.y, color: spore.color, mass: spore.mass });
    }
    this.consumeFood();
    this.stats.observe(this.playerCells);
    this.consumeBalls();
    const beforeMerge = this.playerCells.length;
    this.playerCells = updateCellGroup(this.playerCells, dt, this.bounds);
    if (this.playerCells.length < beforeMerge) {
      this.events.push({ type: "merge", x: this.player.x, y: this.player.y, color: this.player.color });
    }
    this.bots = [...this.botGroups.values()].flatMap(cells => updateCellGroup(cells, dt, this.bounds));
    this.updateProgression();
    // 吞噬后半径会增大，需要再次收紧位置，避免小球长到地图边界之外。
    for (const ball of [...this.playerCells, ...this.bots]) clampCell(ball, this.bounds);
    this.stats.record(this.events);
    this.stats.observe(this.playerCells);
    this.stats.sample(this.elapsed, this.playerCells, this.gameOver);
    this.regrouping &&= this.playerCells.length > 1;
    if (this.practice) {
      this.practice.update(this, dt, input);
      return;
    }
    if (this.gameOver) return;

    if (this.hotspots.update(dt)) {
      this.relocateHotspotFood();
      this.events.push({ type: "hotspots", cycle: this.hotspots.cycle });
    }
    this.refillTimer += dt;
    if (this.refillTimer >= CONFIG.food.refillInterval) {
      this.refillTimer = 0;
      while (this.foods.length < CONFIG.food.count) this.foods.push(this.createFood());
    }
    // 生存局参赛名单固定，出局后不补新人，也不通过动态难度替换或放大其他人。
    if (this.survival) return;
    this.respawnTimer += dt;
    if (this.respawnTimer >= CONFIG.bots.respawnDelay) {
      this.respawnTimer = 0;
      this.refillBots();
    }
    this.difficultyTimer += dt;
    if (this.difficultyTimer >= CONFIG.difficulty.refreshInterval) {
      this.difficultyTimer = 0;
      this.refreshOutdatedBot();
    }
  }

  emitSpore(input) {
    const source = [...this.playerCells].filter(cell => cell.alive && cell.mass >= CONFIG.spore.minimumMass)
      .sort((a, b) => b.mass - a.mass)[0];
    if (!source || this.spores.length >= CONFIG.spore.maxCount) return false;
    let direction = input.target ? { x: input.target.x - source.x, y: input.target.y - source.y } : { x: input.x, y: input.y };
    if (Math.hypot(direction.x, direction.y) < 0.05) direction = { x: source.vx, y: source.vy };
    if (Math.hypot(direction.x, direction.y) < 0.05) direction = { x: 1, y: 0 };
    growBall(source, -CONFIG.spore.mass);
    const length = Math.hypot(direction.x, direction.y) || 1;
    const dx = direction.x / length, dy = direction.y / length;
    const spore = createSpore({ id: `spore-${this.nextId++}`, ownerId: source.ownerId,
      x: Math.max(source.radius, Math.min(this.bounds.width - source.radius, source.x + dx * (source.radius + Math.sqrt(CONFIG.spore.mass) * 2.2 + 12))),
      y: Math.max(source.radius, Math.min(this.bounds.height - source.radius, source.y + dy * (source.radius + Math.sqrt(CONFIG.spore.mass) * 2.2 + 12))),
      direction, color: source.color });
    this.spores.push(spore);
    this.sporeCooldown = CONFIG.spore.cooldown;
    this.events.push({ type: "spore", x: spore.x, y: spore.y, color: source.color });
    return true;
  }

  handleSpikes(input = {}) {
    this.spikeGrid.build(this.spikes);
    const groups = new Map([["player", this.playerCells]]);
    for (const [ownerId, cells] of this.botGroups) groups.set(ownerId, cells);
    for (const [ownerId, cells] of groups) {
      if (!cells.length || cells.some(cell => cell.spikeCooldown > 0)) continue;
      const hit = cells.find(cell => cell.mass >= CONFIG.spikes.minimumMass &&
        this.spikeGrid.queryCircle(cell.x, cell.y, cell.radius + CONFIG.spikes.radius)
          .some(spike => collidesWithSpike(cell, spike)));
      if (!hit) continue;
      if (this.isProtected(hit)) continue;
      const spike = this.spikeGrid.queryCircle(hit.x, hit.y, hit.radius + CONFIG.spikes.radius)
        .find(candidate => collidesWithSpike(hit, candidate));
      if (!spike) continue;
      let direction = ownerId === "player" ? { x: input.x, y: input.y } : { x: hit.vx, y: hit.vy };
      if (Math.hypot(direction.x, direction.y) < 0.05) direction = { x: hit.x - spike.x, y: hit.y - spike.y };
      if (Math.hypot(direction.x, direction.y) < 0.05) direction = { x: 1, y: 0 };
      const length = Math.hypot(direction.x, direction.y) || 1;
      direction = { x: direction.x / length, y: direction.y / length };
      splitCells(cells, direction, this.bounds, () => `${ownerId}-spike-${this.nextId++}`);
      for (const cell of cells) {
        growBall(cell, -cell.mass * CONFIG.spikes.lossRatio);
        cell.spikeCooldown = CONFIG.spikes.cooldown;
        cell.impulseX += direction.x * CONFIG.spikes.pushSpeed;
        cell.impulseY += direction.y * CONFIG.spikes.pushSpeed;
      }
      if (ownerId === "player") this.events.push({ type: "spike", x: hit.x, y: hit.y, color: hit.color, text: "扎刺 −8%" });
    }
  }

  relocateHotspotFood() {
    // 每次换位重新保证约 36% 的存量食物在新区域，数量、颜色和 ID 不变。
    // 优先迁移旧区域的食物，只在不足配额时随机补选普通食物，其余保持原位。
    const quota = Math.round(this.foods.length * CONFIG.hotspots.foodRatio);
    const selected = new Set(this.foods.filter(food => food.hotspotId).slice(0, quota).map(food => food.id));
    const candidates = this.foods.filter(food => !food.hotspotId);
    while (selected.size < quota && candidates.length) {
      const index = Math.floor(this.random() * candidates.length);
      selected.add(candidates[index].id);
      candidates[index] = candidates[candidates.length - 1];
      candidates.pop();
    }
    this.foods = this.foods.map(food => selected.has(food.id) || food.hotspotId
      ? { ...food, ...this.hotspots.sampleFoodPosition(selected.has(food.id)) }
      : food);
  }

  updateProgression() {
    this.peakMass = Math.max(this.peakMass, this.playerGroup.mass);
    const nextStage = getStage(this.score);
    if (nextStage.index > this.stage.index) {
      this.events.push({ type: "milestone", reached: nextStage.previousTarget, stage: nextStage });
    }
    this.stage = nextStage;
    const nextDifficulty = getDifficulty(this.score, this.peakMass, this.elapsed);
    if (nextDifficulty.level > this.difficulty.level) {
      this.events.push({ type: "difficulty", title: nextDifficulty.title, level: nextDifficulty.level });
    }
    this.difficulty = nextDifficulty;
  }

  refillBots() {
    if (this.survival) return;
    // 按三类配额补充，场上始终保留可吞噬对象和需要避让的强敌。
    const attempts = CONFIG.bots.count - this.botGroups.size;
    for (let i = 0; i < attempts; i++) {
      const role = Object.keys(BOT_ROLES).sort((a, b) => {
        const ratio = key => [...this.botGroups.values()].filter(cells => cells[0].role === key).length / BOT_ROLES[key].quota;
        return ratio(a) - ratio(b);
      })[0];
      const bot = this.createBot(Math.floor(this.random() * BOT_NAMES.length), role);
      if (bot) this.bots.push(bot);
    }
  }

  refreshOutdatedBot() {
    if (this.survival) return;
    // 每次最多替换一个视野外的落后 AI，不放大现有球，也不改变眼前的追逐关系。
    const candidates = this.bots.map((bot, index) => ({ bot, index })).filter(({ bot }) => {
      const profile = BOT_ROLES[bot.role];
      return profile && this.botGroups.get(bot.ownerId).length === 1 && outsideView(bot, this.view) &&
        bot.mass < this.difficulty.referenceMass * profile.minRatio * 0.72;
    });
    const priority = { hunter: 3, rival: 2, forager: 1 };
    candidates.sort((a, b) => priority[b.bot.role] - priority[a.bot.role]);
    if (!candidates.length) return;
    const { index } = candidates[0];
    const oldBot = this.bots[index];
    const replacement = this.createBot(Math.floor(this.random() * BOT_NAMES.length), oldBot.role);
    if (replacement) this.bots[index] = replacement;
  }

  consumeFood() {
    const balls = [...this.playerCells, ...this.bots];
    this.ballGrid.build(balls);
    this.foodGrid.build(this.foods);
    // 查询半径必须覆盖当前场上最大的球；固定半径会在大球成长后漏掉
    // “球心相距超过 180、边缘已经碰到”的食物。
    const maxBallRadius = Math.max(...balls.map(ball => ball.radius), 0);
    const order = new Map(balls.map((ball, index) => [ball, index]));
    this.foods = this.foods.filter(food => {
      const candidates = this.ballGrid.queryCircle(food.x, food.y, food.radius + maxBallRadius)
        .sort((a, b) => order.get(a) - order.get(b));
      for (const ball of candidates) {
        if (distanceSquared(ball, food) <= (ball.radius + food.radius) ** 2) {
          growBall(ball, CONFIG.food.mass);
          if (ball.isPlayer) {
            this.score += CONFIG.food.mass;
            this.foodsEaten++;
            this.events.push({ type: "food", x: food.x, y: food.y, color: food.color, mass: CONFIG.food.mass });
          }
          return false;
        }
      }
      return true;
    });
  }

  consumeBalls() {
    if (this.gameOver) return;
    // 大球优先判断；已经被吃的球立即失活，避免同一帧重复加分。
    const balls = [...this.playerCells, ...this.bots].sort((a, b) => b.mass - a.mass);
    this.ballGrid.build(balls);
    const order = new Map(balls.map((ball, index) => [ball, index]));
    const remaining = new Map();
    for (const ball of balls) if (ball.alive) remaining.set(ball.ownerId, (remaining.get(ball.ownerId) ?? 0) + 1);
    const respawns = [];
    for (const eater of balls) {
      const candidates = this.ballGrid.queryCircle(eater.x, eater.y, eater.radius + 1)
        .sort((a, b) => order.get(a) - order.get(b));
      for (const prey of candidates) {
        if (eater.id === prey.id) continue;
        if (this.practice && prey.isPlayer) continue;
        if (this.isProtected(eater) || this.isProtected(prey)) continue;
        if (!canEat(eater, prey)) continue;
        prey.alive = false;
        growBall(eater, prey.mass);
        remaining.set(prey.ownerId, remaining.get(prey.ownerId) - 1);
        if (eater.isPlayer) {
          this.score += Math.round(prey.mass);
          this.eatenBalls++;
          this.events.push({ type: "eat", x: prey.x, y: prey.y, color: prey.color, mass: prey.mass });
          this.stats.observe(this.playerCells);
        }
        if (prey.isPlayer) {
          this.killer = eater.name;
          if (remaining.get(prey.ownerId) === 0) this.stats.death(this.elapsed, 'eaten', eater.name, prey.mass);
          if (!this.survival || remaining.get(prey.ownerId) > 0) {
            this.events.push({ type: "celllost", x: prey.x, y: prey.y, color: prey.color, mass: prey.mass });
          } else this.stats.record([{ type: "celllost" }]);
        }
        if (this.survival && remaining.get(prey.ownerId) === 0) {
          const victim = this.survival.recordDeath(prey.ownerId, eater.ownerId, this.elapsed);
          if (victim) {
            this.events.push({ type: "life", ownerId: eater.ownerId, isPlayer: eater.isPlayer,
              lives: this.survival.roster.get(eater.ownerId)?.lives, victim: prey.name });
            if (victim.lives > 0) respawns.push(victim);
            else this.events.push({ type: "eliminated", ownerId: victim.ownerId, isPlayer: victim.isPlayer, name: victim.name });
          }
        }
      }
    }
    this.lastPlayer = this.player;
    this.playerCells = this.playerCells.filter(cell => cell.alive);
    if (!this.survival && !this.playerCells.length) {
      this.gameOver = true;
      this.events.push({ type: "gameover" });
    }
    this.bots = this.bots.filter(bot => bot.alive);
    for (const owner of respawns) this.respawnOwner(owner);
    if (this.survival) {
      if (this.survival.roster.get("player").lives <= 0) this.finishSurvival("eliminated");
      else if ([...this.survival.roster.values()].filter(owner => owner.lives > 0).length === 1) this.finishSurvival("last-survivor");
    }
  }

  respawnOwner(owner) {
    const position = findRespawnPosition(this.bounds, owner.initialMass, [...this.playerCells, ...this.bots], this.random);
    const ball = createBall({ ...position, id: `respawn-${this.nextId++}`, ownerId: owner.ownerId,
      mass: owner.initialMass, name: owner.name, color: owner.color, isPlayer: owner.isPlayer });
    ball.role = owner.role;
    this.botSplitCooldowns.delete(owner.ownerId);
    if (owner.isPlayer) {
      this.playerCells = [ball];
      this.lastPlayer = ball;
      // 新生命从单球开始，不携带旧技能、速度、弹射或分裂冷却。
      this.sprint = new Sprint();
      this.split = new SplitAbility();
      this.sporeCooldown = 0;
      this.sporeWasPressed = false;
      this.stats.sample(this.elapsed, [ball], true);
    } else this.bots.push(ball);
    this.events.push({ type: "respawn", ownerId: owner.ownerId, isPlayer: owner.isPlayer,
      lives: owner.lives, x: ball.x, y: ball.y, color: ball.color });
  }

  finishSurvival(reason) {
    if (this.gameOver) return;
    const snapshot = this.survival.getSnapshot([...this.playerCells, ...this.bots], this.elapsed);
    const player = snapshot.player;
    this.gameOver = true;
    this.stats.sample(this.elapsed, this.playerCells, true);
    this.result = { reason, rank: player.rank, lives: player.lives, kills: player.kills, deaths: player.deaths,
      won: reason !== "eliminated" && player.rank === 1,
      winners: snapshot.standings.filter(owner => owner.rank === 1).map(owner => owner.name) };
    this.events.push({ type: "gameover" });
  }

  updateBotSplits(dt) {
    const groups = this.botGroups;
    for (const owner of this.botSplitCooldowns.keys()) {
      if (!groups.has(owner)) this.botSplitCooldowns.delete(owner);
      else this.botSplitCooldowns.set(owner, Math.max(0, this.botSplitCooldowns.get(owner) - dt));
    }
    // 只有两名追猎者可分裂，每名最多两个分身，保持单机局势可读。
    const skills = BOT_SKILLS[this.botDifficulty];
    const hunters = [...groups.values()].filter(cells => cells[0].role === "hunter" || this.botDifficulty === "challenge" && cells[0].role === "rival")
      .slice(0, this.botDifficulty === "challenge" ? 4 : CONFIG.split.hunterGroups);
    for (const cells of hunters) {
      const bot = cells[0];
      if (cells.length >= skills.maxCells || (this.botSplitCooldowns.get(bot.ownerId) ?? 0) > 0) continue;
      const direction = chooseBotSplit(bot, this);
      if (!direction) continue;
      const children = splitCells(cells, direction, this.bounds, () => `bot-${this.nextId++}`, skills.maxCells);
      this.bots.push(...children);
      if (children.length) this.botSplitCooldowns.set(bot.ownerId, skills.rest);
    }
  }
}

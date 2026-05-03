const { evaluateSeven, centsToChips } = require('./engine');

const BOT_TYPES = ['manual', 'fish', 'pro'];
const RANK_ORDER = '23456789TJQKA';

function rankValue(card) {
  return RANK_ORDER.indexOf(card[0]) + 2;
}

function legalAction(legal, type) {
  return legal.actions.find((action) => action.type === type);
}

function clampAmount(value, wager) {
  const min = Number(wager.min || 0);
  const max = Number(wager.max || 0);
  const rounded = Math.round(Number(value || min));
  return Math.min(max, Math.max(min, rounded));
}

function passiveDecision(legal, reason = 'takes the low-variance option') {
  if (legal.toCall > 0 && legalAction(legal, 'call')) return { action: 'call', reason };
  if (legalAction(legal, 'check')) return { action: 'check', reason };
  return { action: 'fold', reason };
}

function foldDecision(legal, reason = 'lets the weak hand go') {
  if (legal.toCall > 0 && legalAction(legal, 'fold')) return { action: 'fold', reason };
  return passiveDecision(legal, reason);
}

function potInChips(game) {
  return Math.max(centsToChips(game.potTotal()), centsToChips(game.settings.bigBlind));
}

function wagerTarget(game, legal, player, type, fraction) {
  const wager = legalAction(legal, type);
  if (!wager) return null;
  const pot = potInChips(game);
  const toCall = Number(legal.toCall || 0);
  const playerStreetBet = centsToChips(player.streetBet);
  const bigBlind = centsToChips(game.settings.bigBlind);
  const raw = type === 'raise'
    ? playerStreetBet + toCall + fraction * (pot + toCall)
    : Math.max(bigBlind, fraction * pot);
  return clampAmount(raw, wager);
}

function raiseDecision(game, legal, player, fraction, reason) {
  const amount = wagerTarget(game, legal, player, 'raise', fraction);
  if (amount !== null) return { action: 'raise', amount, reason };
  return passiveDecision(legal, reason);
}

function betDecision(game, legal, player, fraction, reason) {
  const amount = wagerTarget(game, legal, player, 'bet', fraction);
  if (amount !== null) return { action: 'bet', amount, reason };
  return passiveDecision(legal, reason);
}

function aggressiveDecision(game, legal, player, fraction, reason) {
  if (legal.toCall > 0) return raiseDecision(game, legal, player, fraction, reason);
  return betDecision(game, legal, player, fraction, reason);
}

function preflopScore(hand) {
  const values = hand.map(rankValue).sort((a, b) => b - a);
  const [high, low] = values;
  const suited = hand[0][1] === hand[1][1];
  const pair = high === low;
  const gap = Math.max(0, high - low - 1);

  if (pair) return 50 + high * 3;

  let score = high * 3 + low * 1.7;
  if (high === 14) score += 6;
  if (high >= 10 && low >= 10) score += 7;
  if (suited) score += 4;
  if (gap === 0) score += 3;
  else if (gap === 1) score += 2;
  else if (gap === 2) score += 0.5;
  else score -= gap * 2;
  return score;
}

function rankCounts(cards) {
  const counts = new Map();
  for (const card of cards) {
    const rank = rankValue(card);
    counts.set(rank, (counts.get(rank) || 0) + 1);
  }
  return counts;
}

function suitCounts(cards) {
  const counts = new Map();
  for (const card of cards) counts.set(card[1], (counts.get(card[1]) || 0) + 1);
  return counts;
}

function maxStraightWindowPresence(cards) {
  const ranks = new Set(cards.map(rankValue));
  if (ranks.has(14)) ranks.add(1);
  let maxPresent = 0;
  for (let high = 5; high <= 14; high += 1) {
    const run = [high, high - 1, high - 2, high - 3, high - 4];
    maxPresent = Math.max(maxPresent, run.filter((rank) => ranks.has(rank)).length);
  }
  return maxPresent;
}

function hasFlushDraw(cards) {
  return Array.from(suitCounts(cards).values()).some((count) => count === 4);
}

function hasStraightDraw(cards) {
  return maxStraightWindowPresence(cards) >= 4;
}

function boardTexture(board) {
  const cards = board.filter(Boolean);
  const ranks = cards.map(rankValue);
  const uniqueRanks = new Set(ranks);
  const suits = suitCounts(cards);
  const maxSuit = Math.max(0, ...Array.from(suits.values()));
  const straightPresence = maxStraightWindowPresence(cards);
  const paired = uniqueRanks.size < ranks.length;
  const monotone = maxSuit >= 3;
  const twoTone = maxSuit === 2;
  const sortedRanks = Array.from(uniqueRanks).sort((a, b) => a - b);
  const connectedPair = sortedRanks.some((rank, index) => index > 0 && rank - sortedRanks[index - 1] <= 1);
  const closePair = sortedRanks.some((rank, index) => index > 0 && rank - sortedRanks[index - 1] <= 2);
  const clustered = ranks.length >= 3 && Math.max(...ranks) - Math.min(...ranks) <= 6;

  let wetness = 0;
  if (twoTone) wetness += 1;
  if (monotone) wetness += 2;
  if (straightPresence >= 3) wetness += 2;
  else if (connectedPair) wetness += 2;
  else if (closePair || (straightPresence === 2 && clustered)) wetness += 1;
  if (clustered && !paired) wetness += 1;
  if (paired && wetness > 0) wetness -= 1;

  const dynamicBoard = !paired && (monotone || wetness >= 3 || straightPresence >= 3 || (twoTone && connectedPair));
  const wetBoard = wetness >= 3 || monotone;
  const dryBoard = wetness <= 1 && !monotone && straightPresence < 3;
  const staticBoard = !dynamicBoard;

  return {
    boardTexture: wetBoard && dynamicBoard ? 'wet-dynamic' : dryBoard && staticBoard ? 'dry-static' : 'mixed',
    wetBoard,
    dryBoard,
    dynamicBoard,
    staticBoard,
    wetDynamicBoard: wetBoard && dynamicBoard,
    dryStaticBoard: dryBoard && staticBoard,
    boardWetness: wetness,
    pairedBoard: paired,
    monotoneBoard: monotone,
    twoToneBoard: twoTone,
    connectedPair,
    closePair,
    straightPresence
  };
}

function postflopTexture(hand, board) {
  const cards = [...hand, ...board].filter(Boolean);
  const evaluation = cards.length >= 5 ? evaluateSeven(cards) : { score: [0], name: 'High card' };
  const category = evaluation.score[0];
  const boardRanks = board.map(rankValue);
  const topBoardRank = boardRanks.length ? Math.max(...boardRanks) : 0;
  const counts = rankCounts(cards);
  const handRanks = hand.map(rankValue);
  const madePairs = Array.from(counts.entries())
    .filter(([rank, count]) => count >= 2 && handRanks.includes(rank))
    .map(([rank]) => rank)
    .sort((a, b) => b - a);
  const pairRank = madePairs[0] || 0;
  const topPair = category === 1 && pairRank >= topBoardRank && pairRank > 0;
  const overPair = category === 1 && handRanks[0] === handRanks[1] && handRanks[0] > topBoardRank;
  const flushDraw = category < 5 && hasFlushDraw(cards);
  const straightDraw = category < 4 && hasStraightDraw(cards);
  const comboDraw = flushDraw && straightDraw;
  const pairAndDraw = category === 1 && (flushDraw || straightDraw);
  const overcards = boardRanks.length > 0 ? handRanks.filter((rank) => rank > topBoardRank).length : 0;

  return {
    category,
    handName: evaluation.name,
    topPair,
    overPair,
    pairRank,
    flushDraw,
    straightDraw,
    comboDraw,
    pairAndDraw,
    strongDraw: comboDraw || flushDraw || straightDraw,
    overcards,
    score: evaluation.score,
    ...boardTexture(board)
  };
}

function callPrice(legal, game) {
  const toCall = Number(legal.toCall || 0);
  if (toCall <= 0) return 0;
  return toCall / Math.max(1, potInChips(game) + toCall);
}

function decideProPreflop(game, legal, player, hand, random) {
  const score = preflopScore(hand);
  const price = callPrice(legal, game);

  if (legal.toCall > 0) {
    if (score >= 84 && legalAction(legal, 'raise') && random() < 0.82) {
      return raiseDecision(game, legal, player, 0.9, 'pressures a premium preflop hand');
    }
    if (score >= 66 || (score >= 54 && price <= 0.24)) return { action: 'call', reason: 'continues with playable preflop equity' };
    if (score >= 58 && legalAction(legal, 'raise') && random() < 0.22) {
      return raiseDecision(game, legal, player, 0.7, 'mixes in a disciplined light 3-bet');
    }
    return foldDecision(legal, 'folds a low-EV preflop hand');
  }

  if (score >= 64 && legalAction(legal, 'raise') && random() < 0.72) {
    return raiseDecision(game, legal, player, 0.75, 'opens or isolates a strong preflop hand');
  }
  return passiveDecision(legal, 'declines to bloat the pot preflop');
}

function decideFishPreflop(game, legal, player, hand, random) {
  const score = preflopScore(hand);
  const price = callPrice(legal, game);

  if (legal.toCall > 0) {
    if (score >= 78 && legalAction(legal, 'raise') && random() < 0.32) {
      return raiseDecision(game, legal, player, 0.55, 'raises a hand that looks too pretty to call');
    }
    if (score >= 34 || price <= 0.34 || random() < 0.18) {
      return { action: 'call', reason: 'finds a preflop call with a wide range' };
    }
    return foldDecision(legal, 'finally gives up a weak preflop holding');
  }

  if (score >= 76 && legalAction(legal, 'raise') && random() < 0.35) {
    return raiseDecision(game, legal, player, 0.55, 'raises a premium but keeps the sizing modest');
  }
  return passiveDecision(legal, 'checks the option with most of the range');
}

function decideProPostflop(game, legal, player, hand, board, random) {
  const texture = postflopTexture(hand, board);
  const price = callPrice(legal, game);

  if (legal.toCall > 0) {
    if (texture.category >= 4) return raiseDecision(game, legal, player, 0.95, 'fast-plays ' + texture.handName);
    if (texture.category >= 2 || texture.overPair) {
      if (legalAction(legal, 'raise') && random() < 0.42) return raiseDecision(game, legal, player, 0.72, 'raises for value with ' + texture.handName);
      return { action: 'call', reason: 'continues with ' + texture.handName };
    }
    if (texture.topPair && price <= 0.42) return { action: 'call', reason: 'continues with top pair at a reasonable price' };
    if (texture.strongDraw && price <= 0.36) {
      if (legalAction(legal, 'raise') && random() < 0.3) return raiseDecision(game, legal, player, 0.68, 'uses a strong draw as a semi-bluff');
      return { action: 'call', reason: 'calls with drawing equity and pot odds' };
    }
    if (texture.overcards >= 2 && price <= 0.18 && random() < 0.28) return { action: 'call', reason: 'peels once with overcards getting a price' };
    return foldDecision(legal, 'folds weak showdown value to pressure');
  }

  if (texture.category >= 2 || texture.overPair) return betDecision(game, legal, player, 0.72, 'value bets ' + texture.handName);
  if (texture.topPair) return betDecision(game, legal, player, 0.58, 'bets top pair for value and protection');
  if (texture.strongDraw && random() < 0.58) return betDecision(game, legal, player, 0.42, 'semi-bluffs a draw');
  if (texture.overcards >= 2 && random() < 0.16) return betDecision(game, legal, player, 0.34, 'takes a small stab with overcards');
  return passiveDecision(legal, 'checks with weak showdown value or air');
}

function fishValueBetFrequency(texture) {
  if (texture.wetDynamicBoard) return texture.category >= 3 ? 0.88 : 0.72;
  if (texture.dryStaticBoard) return texture.category >= 3 ? 0.38 : 0.26;
  return texture.category >= 3 ? 0.66 : 0.52;
}

function fishValueRaiseFrequency(texture) {
  if (texture.wetDynamicBoard) return texture.category >= 3 ? 0.72 : 0.42;
  if (texture.dryStaticBoard) return texture.category >= 3 ? 0.18 : 0.08;
  return texture.category >= 3 ? 0.36 : 0.2;
}

function fishValueSizing(texture) {
  if (texture.wetDynamicBoard) return texture.category >= 3 ? 0.78 : 0.62;
  if (texture.dryStaticBoard) return texture.category >= 3 ? 0.48 : 0.36;
  return texture.category >= 3 ? 0.62 : 0.5;
}

function decideFishPostflop(game, legal, player, hand, board, random) {
  const texture = postflopTexture(hand, board);
  const price = callPrice(legal, game);
  const strongValue = texture.category >= 3;
  const mediumValue = texture.category >= 2 || texture.topPair || texture.overPair;
  const drawOnly = texture.strongDraw && !strongValue && !mediumValue;

  if (legal.toCall > 0) {
    if (strongValue || mediumValue) {
      const frequency = fishValueRaiseFrequency(texture);
      if (legalAction(legal, 'raise') && random() < frequency) {
        const reason = texture.wetDynamicBoard
          ? 'fast-plays value on a wet dynamic board'
          : texture.dryStaticBoard
            ? 'occasionally slowplays value even when raising'
            : 'raises visible value on a mixed board';
        return raiseDecision(game, legal, player, fishValueSizing(texture), reason);
      }
      if (price <= 0.7 || random() < 0.34) {
        const reason = texture.dryStaticBoard
          ? 'slowplays value on a dry static board'
          : 'continues with a made hand';
        return { action: 'call', reason };
      }
    }

    if (drawOnly) {
      if (texture.comboDraw && price <= 0.68) return { action: 'call', reason: 'passively calls with a combo draw' };
      if (price <= 0.55 || random() < 0.18) return { action: 'call', reason: 'passively chases a draw' };
      return foldDecision(legal, 'lets an overpriced draw go');
    }

    if (texture.overcards >= 1 && (price <= 0.24 || random() < 0.2)) {
      return { action: 'call', reason: 'pays off a small bet with curiosity equity' };
    }
    return foldDecision(legal, 'folds after missing too much of the board');
  }

  if (strongValue || mediumValue) {
    if (random() < fishValueBetFrequency(texture)) {
      const reason = texture.wetDynamicBoard
        ? 'fast-plays value before scary cards arrive'
        : texture.dryStaticBoard
          ? 'bets value despite a dry board'
          : 'bets visible value on a mixed board';
      return betDecision(game, legal, player, fishValueSizing(texture), reason);
    }
    const reason = texture.dryStaticBoard
      ? 'slowplays value on a dry static board'
      : 'checks a made hand passively';
    return passiveDecision(legal, reason);
  }

  if (drawOnly) {
    return passiveDecision(legal, texture.comboDraw ? 'checks a combo draw passively' : 'checks a draw passively');
  }

  return passiveDecision(legal, 'checks too many medium and weak hands');
}

function decideBotAction(game, seat, botType, options = {}) {
  const type = String(botType || 'manual').toLowerCase();
  if (!BOT_TYPES.includes(type) || type === 'manual') return null;

  const player = game.player(seat);
  const legal = game.getLegalActions(seat);
  if (!legal.canAct) return null;
  if (!player.hand.every(Boolean)) return passiveDecision(legal, 'has incomplete hole-card information');

  const random = typeof options.random === 'function' ? options.random : Math.random;
  const board = game.board.filter(Boolean);
  const decision = board.length === 0
    ? (type === 'pro'
      ? decideProPreflop(game, legal, player, player.hand, random)
      : decideFishPreflop(game, legal, player, player.hand, random))
    : (type === 'pro'
      ? decideProPostflop(game, legal, player, player.hand, board, random)
      : decideFishPostflop(game, legal, player, player.hand, board, random));

  const available = legalAction(legal, decision.action);
  if (!available) return passiveDecision(legal, 'falls back to the nearest legal action');
  if ((decision.action === 'bet' || decision.action === 'raise') && decision.amount === undefined) {
    return aggressiveDecision(game, legal, player, 0.5, decision.reason || 'uses a default value size');
  }
  return decision;
}

module.exports = {
  BOT_TYPES,
  boardTexture,
  decideBotAction,
  preflopScore,
  postflopTexture
};

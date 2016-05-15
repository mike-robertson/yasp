/**
 * Functions to build player object
 **/
var async = require('async');
var constants = require('../constants.js');
var queries = require("../store/queries");
var utility = require('../util/utility');
var aggregator = require('../util/aggregator');
var config = require('../config');
var playerCache = require('../store/playerCache');
var getPlayerMatches = queries.getPlayerMatches;
var getPlayer = queries.getPlayer;
var getPlayerRankings = queries.getPlayerRankings;
var generatePositionData = utility.generatePositionData;
var preprocessQuery = utility.preprocessQuery;
var readCache = playerCache.readCache;
var writeCache = playerCache.writeCache;
var validateCache = playerCache.validateCache;
var player_fields = constants.player_fields;
var subkeys = player_fields.subkeys;
var countCats = player_fields.countCats;
//Fields to project from player_match table
//optimize by only projecting certain columns based on tab
//set query.project based on this
var basic = ['player_matches.match_id', 'hero_id', 'start_time', 'duration', 'kills', 'deaths', 'assists', 'player_slot', 'account_id', 'game_mode', 'lobby_type', 'radiant_win', 'leaver_status', 'cluster', 'parse_status', 'pgroup'];
var advanced = ['last_hits', 'denies', 'gold_per_min', 'xp_per_min', 'gold_t', 'level', 'hero_damage', 'tower_damage', 'hero_healing', 'stuns', 'killed', 'pings', 'radiant_gold_adv', 'actions'];
var others = ['purchase', 'lane_pos', 'kill_streaks', 'multi_kills', 'obs', 'sen', 'purchase_log', 'item_uses', 'hero_hits', 'ability_uses', 'chat'];
var everything = basic.concat(advanced).concat(others);
var projections = {
    index: basic,
    matches: basic,
    heroes: basic,
    peers: basic,
    activity: basic,
    counts: basic.concat(advanced).concat(['purchase', 'kill_streaks', 'multi_kills', 'lane_pos']),
    histograms: basic.concat(advanced).concat(['purchase']),
    trends: basic.concat(advanced).concat(['purchase']),
    wardmap: basic.concat(['obs', 'sen']),
    items: basic.concat(['purchase', 'purchase_log', 'item_uses']),
    skills: basic.concat(['hero_hits', 'ability_uses']),
    wordcloud: basic.concat('chat'),
    rating: basic,
    rankings: basic,
    hyperopia: basic
};
//Fields to aggregate on
//optimize by only aggregating certain columns based on tab
//set query.js_agg based on this
var basicAggs = ['match_id', 'version', 'abandons', 'win', 'lose'];
var aggs = {
    index: basicAggs.concat('heroes'),
    matches: basicAggs,
    heroes: basicAggs.concat('heroes'),
    peers: basicAggs.concat('teammates'),
    activity: basicAggs.concat('start_time'),
    counts: basicAggs.concat(Object.keys(subkeys)).concat(Object.keys(countCats)).concat(['multi_kills', 'kill_streaks', 'lane_role']),
    //TODO only need one subkey at a time
    histograms: basicAggs.concat(Object.keys(subkeys)),
    trends: basicAggs.concat(Object.keys(subkeys)),
    wardmap: basicAggs.concat(['obs', 'sen']),
    items: basicAggs.concat(['purchase_time', 'item_usage', 'item_uses', 'purchase', 'item_win']),
    skills: basicAggs.concat(['hero_hits', 'ability_uses']),
    wordcloud: basicAggs.concat(['my_word_counts', 'all_word_counts']),
    rating: basicAggs,
    rankings: basicAggs,
    hyperopia: basicAggs
};
//Fields to project from Cassandra player caches
var cacheProj = ['account_id', 'match_id', 'player_slot', 'version', 'start_time', 'duration', 'game_mode', 'lobby_type', 'radiant_win', 'hero_id', 'game_mode', 'skill', 'duration', 'kills', 'deaths', 'assists', 'last_hits', 'gold_per_min', 'parse_status'];
var cacheFilters = ['heroes', 'teammates', 'hero_id', 'isRadiant', 'lane_role', 'game_mode', 'lobby_type', 'region', 'patch', 'start_time', 'lane_role'];

function buildPlayer(options, cb)
{
    var db = options.db;
    var redis = options.redis;
    var account_id = options.account_id;
    var orig_account_id = account_id;
    var info = options.info || "index";
    var subkey = options.subkey;
    var query = options.query;
    if (Number.isNaN(account_id))
    {
        return cb("non-numeric account_id");
    }
    if (Number(account_id) === constants.anonymous_account_id)
    {
        return cb("cannot generate profile for anonymous account_id");
    }
    var queryObj = {
        select: query
    };
    account_id = Number(account_id);
    //select player_matches with this account_id
    queryObj.select.account_id = account_id;
    queryObj = preprocessQuery(queryObj);
    //1 filter expected for account id
    var filter_exists = queryObj.filter_count > 1;
    //choose fields to project based on tab/filter, we need to project everything to build a new cache/toplist, otherwise optimize and do a subset
    queryObj.project = everything;
    //choose fields to aggregate based on tab
    var obj = {};
    aggs[info].forEach(function(k)
    {
        obj[k] = 1;
    });
    queryObj.js_agg = obj;
    //fields to project from the Cassandra cache
    queryObj.cacheProject = Object.keys(queryObj.js_agg).concat(cacheProj).concat(filter_exists ? cacheFilters : []).concat(query.desc ? query.desc : []);
    //Find player in db
    console.time("[PLAYER] getPlayer " + account_id);
    getPlayer(db, account_id, function(err, player)
    {
        console.timeEnd("[PLAYER] getPlayer " + account_id);
        if (err)
        {
            return cb(err);
        }
        player = player ||
        {
            account_id: account_id,
            personaname: account_id
        };
        console.time("[PLAYER] readCache " + account_id);
        readCache(orig_account_id, queryObj, function(err, cache)
        {
            console.timeEnd("[PLAYER] readCache " + account_id);
            if (err)
            {
                return cb(err);
            }
            //check count of matches in db to validate cache
            console.time("[PLAYER] validateCache " + account_id);
            validateCache(db, redis, account_id, cache, function(err, valid)
            {
                console.timeEnd("[PLAYER] validateCache " + account_id);
                if (err)
                {
                    return cb(err);
                }
                if (!valid)
                {
                    console.log("player cache miss %s", player.account_id);
                    console.time("[PLAYER] getPlayerMatches " + account_id);
                    getPlayerMatches(db, queryObj, options, function(err, results)
                    {
                        console.timeEnd("[PLAYER] getPlayerMatches " + account_id);
                        if (err)
                        {
                            return cb(err);
                        }
                        //save the cache if complete data
                        if (!filter_exists && player.account_id !== constants.anonymous_account_id)
                        {
                            console.time("[PLAYER] writeCache " + account_id);
                            writeCache(player.account_id, results, function(err)
                            {
                                if (err)
                                {
                                    console.error(err);
                                }
                                console.timeEnd("[PLAYER] writeCache " + account_id);
                            });
                        }
                        //don't need to wait for cache write
                        processResults(err, results);
                    });
                }
                else
                {
                    console.log("player cache hit %s", player.account_id);
                    options.cache = true;
                    processResults(err, cache);
                }
            });
        });

        function processResults(err, cache)
        {
            if (err)
            {
                return cb(err);
            }
            var matches = cache.raw;
            var desc = queryObj.keywords.desc || "match_id";
            var limit = queryObj.keywords.limit ? Number(queryObj.keywords.limit) : undefined;
            //sort
            matches = matches.sort(function(a, b)
            {
                if (a[desc] === undefined || b[desc] === undefined)
                {
                    return a[desc] === undefined ? 1 : -1;
                }
                return Number(b[desc]) - Number(a[desc]);
            });
            //limit
            matches = matches.slice(0, limit);
            //aggregate
            var aggData = aggregator(matches, queryObj.js_agg);
            async.parallel(
            {
                profile: function(cb)
                {
                    return cb(null, player);
                },
                win: function(cb)
                {
                    return cb(null, aggData.win.sum);
                },
                lose: function(cb)
                {
                    return cb(null, aggData.lose.sum);
                },
                matches: function(cb)
                {
                    if (info === "index" || info === "matches")
                    {
                        var project = ["match_id", "player_slot", "hero_id", "game_mode", "kills", "deaths", "assists", "parse_status", "skill", "radiant_win", "start_time", "duration"].concat(queryObj.keywords.desc || []);
                        var limit = Number(queryObj.keywords.limit) || 20;
                        //project
                        matches = matches.map(function(pm)
                        {
                            var obj = {};
                            project.forEach(function(key)
                            {
                                obj[key] = pm[key];
                            });
                            return obj;
                        });
                        //limit
                        matches = matches.slice(0, limit);
                        fillSkill(db, matches, options, cb);
                    }
                    else
                    {
                        cb(null, []);
                    }
                },
                heroes_list: function(cb)
                {
                    //convert heroes hash to array and sort
                    if (aggData.heroes)
                    {
                        var heroes_list = [];
                        var heroes = aggData.heroes;
                        for (var id in heroes)
                        {
                            var h = heroes[id];
                            heroes_list.push(h);
                        }
                        heroes_list.sort(function(a, b)
                        {
                            return b.games - a.games;
                        });
                        heroes_list = heroes_list.slice(0, info === "index" ? 20 : undefined);
                        cb(null, heroes_list);
                    }
                    else
                    {
                        return cb(null, []);
                    }
                },
                teammate_list: function(cb)
                {
                    if (info === "peers")
                    {
                        generateTeammateArrayFromHash(db, aggData.teammates, player, cb);
                    }
                    else
                    {
                        return cb();
                    }
                },
                mmr_estimate: function(cb)
                {
                    queries.mmrEstimate(db, redis, account_id, cb);
                },
                ratings: function(cb)
                {
                    if (info === "rating")
                    {
                        queries.getPlayerRatings(db, account_id, cb);
                    }
                    else
                    {
                        cb();
                    }
                },
                solo_competitive_rank: function(cb)
                {
                    redis.zscore('solo_competitive_rank', account_id, cb);
                },
                competitive_rank: function(cb)
                {
                    redis.zscore('competitive_rank', account_id, cb);
                },
                rankings: function(cb)
                {
                    if (info === "rankings")
                    {
                        getPlayerRankings(redis, account_id, cb);
                    }
                    else
                    {
                        return cb();
                    }
                },
                activity: function(cb)
                {
                    if (info === "activity")
                    {
                        return cb(null, aggData.start_time);
                    }
                    else
                    {
                        return cb();
                    }
                },
                wardmap: function(cb)
                {
                    if (info === "wardmap")
                    {
                        //generally position data function is used to generate heatmap data for each player in a natch
                        //we use it here to generate a single heatmap for aggregated counts
                        var ward_data = {
                            obs: aggData.obs,
                            sen: aggData.sen,
                        };
                        var ward_counts = {
                            obs: ward_data.obs.counts,
                            sen: ward_data.sen.counts,
                        };
                        var d = {
                            "obs": true,
                            "sen": true
                        };
                        generatePositionData(d, ward_counts);
                        var obj = {
                            posData: [d]
                        };
                        return cb(null, Object.assign(
                        {}, obj, ward_data));
                    }
                    else
                    {
                        return cb();
                    }
                },
                wordcloud: function(cb)
                {
                    if (info === "wordcloud")
                    {
                        return cb(null,
                        {
                            my_word_counts: aggData.my_word_counts,
                            all_word_counts: aggData.all_word_counts
                        });
                    }
                    else
                    {
                        return cb();
                    }
                },
                aggData: function(cb)
                {
                    if (info === "histograms" || info === "counts" || info === "trends" || info === "items" || info === "skills")
                    {
                        return cb(null, aggData);
                    }
                    else
                    {
                        return cb();
                    }
                }
            }, cb);
        }
    });
}

function generateTeammateArrayFromHash(db, input, player, cb)
{
    if (!input)
    {
        return cb();
    }
    console.time('[PLAYER] generateTeammateArrayFromHash ' + player.account_id);
    var teammates_arr = [];
    var teammates = input;
    for (var id in teammates)
    {
        var tm = teammates[id];
        id = Number(id);
        //don't include if anonymous, self or if few games together
        if (id && id !== Number(player.account_id) && id !== constants.anonymous_account_id && (tm.games >= 5))
        {
            teammates_arr.push(tm);
        }
    }
    teammates_arr.sort(function(a, b)
    {
        return b.games - a.games;
    });
    //limit to 200 max players
    teammates_arr = teammates_arr.slice(0, 200);
    async.each(teammates_arr, function(t, cb)
    {
        db.first().from('players').where(
        {
            account_id: t.account_id
        }).asCallback(function(err, row)
        {
            if (err || !row)
            {
                return cb(err);
            }
            t.personaname = row.personaname;
            t.last_login = row.last_login;
            t.avatar = row.avatar;
            cb(err);
        });
    }, function(err)
    {
        console.timeEnd('[PLAYER] generateTeammateArrayFromHash ' + player.account_id);
        cb(err, teammates_arr);
    });
}

function fillSkill(db, matches, options, cb)
{
    //fill in skill data from table (only necessary if reading from cache since adding skill data doesn't update cache)
    console.time('[PLAYER] fillSkill');
    //get skill data for matches within cache expiry (might not have skill data)
    /*
    var recents = matches.filter(function(m)
    {
        return moment().diff(moment.unix(m.start_time), 'days') <= config.UNTRACK_DAYS;
    });
    */
    //just get skill for last N matches (faster)
    var recents = matches.slice(0, 30);
    var skillMap = {};
    db.select(['match_id', 'skill']).from('match_skill').whereIn('match_id', recents.map(function(m)
    {
        return m.match_id;
    })).asCallback(function(err, rows)
    {
        if (err)
        {
            return cb(err);
        }
        console.log("fillSkill recents: %s, results: %s", recents.length, rows.length);
        rows.forEach(function(match)
        {
            skillMap[match.match_id] = match.skill;
        });
        matches.forEach(function(m)
        {
            m.skill = m.skill || skillMap[m.match_id];
        });
        console.timeEnd('[PLAYER] fillSkill');
        return cb(err, matches);
    });
}
module.exports = buildPlayer;
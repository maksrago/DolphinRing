//Loading add-on, at this point its safe to reference engine components

"use strict";

const config = require("./config");

const mongodb = require("mongodb");
const https = require("https");
const cluster = require("cluster");
const fs = require("fs");
const path = require("path");

const settingsHandler = require("../../settingsHandler");
const settings = settingsHandler.getGeneralSettings();

const requestHandler = require("../../engine/requestHandler");
const miscPages = require("../../engine/domManipulator").dynamicPages.miscPages;
const lang = require("../../engine/langOps").languagePack;
const getTemplates = require("../../engine/templateHandler").getTemplates;
const common = require("../../engine/domManipulator").common;
const miscOps = require("../../engine/miscOps");

const db = require("../../db");
/** @type mongodb.Collection */
const boards = db.boards();

/**
 * A board used in the webring data.
 * @typedef {Object} WebringBoard
 * @property {string} uri - The board URI
 * @property {string} title - The board title/name
 * @property {string=} subtitle - The board subtitle/description
 * @property {string} path - The URL for the board
 * @property {number=} postsPerHour - The number of posts in the last hour
 * @property {number=} totalPosts - The total amount of posts on the board
 * @property {number=} uniqueUsers - The number of unique ISPs on the board
 * @property {bool} nsfw - Whether this imageboard is Not Safe For Work
 */

/**
 * The webring data.
 *
 * @typedef {Object} Webring
 * @property {string} name - The name of the imageboard
 * @property {string} url - The base site URL
 * @property {string[]} logo - The imageboard's logos, an array of images.
 * @property {string[]} following - The other nodes this node is connected to.
 * @property {string[]} blacklist - The nodes this node will not connect to.
 * @property {WebringBoard[]} boards - The boards on the site
 */

/**
 * Generates JSON for the webring configuration, and sends it to the user.
 *
 * @param {https.ClientRequest} req - The request
 * @param {https.ServerResponse} res - The response
 * @interface public
 *
 */
const generateWebringJSON = (req, res, spiderCache, extensionData) => {
  boards.find({}).toArray((error, results) => {
    if (error) {
      // TODO graceful handling
      throw error;
    }

    console.log(spiderCache);

    const data = {
      name: settings.siteTitle,
      url: config.url,
      endpoint: config.url + "/dolphinring.json",
      logo: config.logos,

      following: config.following,
      known: [...spiderCache],
      blacklist: [...config.blacklist],

      boards: results
        .filter(board => !board.settings || !board.settings.includes("unindex"))
        .map(board => ({
          uri: board.boardUri,
          title: board.boardName,
          subtitle: board.boardDescription,
          path: config.url + "/" + board.boardUri + "/",

          postsPerHour: board.postsPerHour,
          totalPosts: board.lastPostId,
          uniqueUsers: board.uniqueIps,
          nsfw: !(
            board.specialSettings && board.specialSettings.indexOf("sfw") > -1
          ),
          tags: board.tags,
          lastPostTimestamp: board.lastPostDate
            ? board.lastPostDate.toISOString()
            : null
        })),

      extensions: extensionData
    };

    res.writeHead(200, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify(data));
  });
};

/**
 * Implementation of https.request using Promises. This allows usage of
 * Promise utilities like Promise.all.
 *
 * @param {(string|url.URL)} url - The path
 * @param {https.RequestOptions} [options] - request options
 * @return {Promise<string>}
 */
const requestAsync = (url, options) =>
  new Promise((resolve, reject) => {
    const callback = res => {
      let accumulator = "";

      res.on("data", chunk => {
        accumulator += chunk;
      });

      res.on("end", () => {
        resolve(accumulator);
      });
    };

    const req = https.request(
      url,
      options || callback,
      options ? callback : null
    );
    req.on("error", reject);
    req.end();
  });

/**
 * Fetches data from all remote webrings and returns the data.
 *
 * @param {Set<string>} spiderCache - the cache for the webring spiderweb
 * @param {(ibs: Webring[]) => void} callback - The callback
 */
const fetchRemoteWebring = (spiderCache, callback) => {
  const remoteBoards = [];

  /** @type {Set<string>} */
  const toVisit = new Set([...spiderCache].concat(config.following));
  /** @type {Set<string>} */
  const seenDomains = new Set();

  // make sure i'm not following myself
  toVisit.add(config.url + "/dolphinring.json");
  seenDomains.add(config.url + "/dolphinring.json");

  (function inner() {
    // collect all domains that we didn't go to yet
    /** @type {string[]} */
    const notVisited = [...toVisit].filter(url => !seenDomains.has(url));

    if (!notVisited.length) {
      callback(remoteBoards);
      return;
    }

    // do all the requests at once...
    const requests = notVisited.map(url =>
      requestAsync(url, {
        headers: {
          Accept: "application/json",
          "X-Webring": "Ahoy!"
        }
      })
        .then(data => {
          /** @type {Webring} */
          const webring = JSON.parse(data);
          remoteBoards.push(webring);

          spiderCache.add(url);
          // make sure we remember that we checked this domain
          seenDomains.add(url);
          // filter the new domains using the blacklist
          return (webring.following || [])
            .filter(url => !config.blacklist.some(i => url.includes(i)));
        })
        .catch(err => {
          console.warn("[Webring] Couldn't parse webring data from", url);
          console.warn(err);

          // to avoid repeated requests, delete the domain from the sets
          toVisit.delete(url);
          seenDomains.delete(url);
          return [];
        })
    );

    // ...and wait for the results
    Promise.all(requests).then(newNodes => {
      newNodes.forEach(nodes => nodes.forEach(node => toVisit.add(node)));

      if (toVisit.size > seenDomains.size) {
        // if new domains were collected, recurse
        inner();
      } else {
        callback(remoteBoards);
      }
    });
  })();
};

/**
 * Takes in raw webring data and normalizes it into a list of boards for
 * LynxChan.
 *
 * @param {Webring[]} data - The webring data
 * @return {Object[]}
 */
const normalizeWebrings = data => {
  const output = [];

  data.forEach(ib => {
    ib.boards.forEach(board => {
      output.push({
        boardUri: board.uri,
        boardName: board.title,
        boardDescription: board.subtitle || "",

        postsPerHour: board.postsPerHour || "???",
        lastPostId: board.totalPosts || "???",
        uniqueIps: board.uniqueUsers || "???",

        ibName: ib.name,
        absPath: board.path
      });
    });
  });

  return output;
};

const webringInternal = (webringData, extensionData, callback) => {
  boards
    .find(
      {},
      {
        projection: {
          _id: 0,
          boardUri: 1,
          boardName: 1,
          boardDescription: 1,
          postsPerHour: 1,
          lastPostId: 1,
          uniqueIps: 1,
          specialSettings: 1,
          tags: 1,
          lastPostDate: 1
        }
      }
    )
    .toArray((error, results) => {
      if (error) {
        // TODO graceful handling
        throw error;
      }

      const data = {
        imageboards: [
          // this imageboard
          {
            name: settings.siteTitle,
            url: config.url,
            logo: config.logos,
            local: true,
            boards: results.map(board => ({
              uri: board.boardUri,
              title: board.boardName,
              subtitle: board.boardDescription,
              path: config.url + "/" + board.boardUri + "/",
              postsPerHour: board.postsPerHour,
              totalPosts: board.lastPostId,
              uniqueUsers: board.uniqueIps,
              nsfw: !(
                board.specialSettings &&
                board.specialSettings.indexOf("sfw") > -1
              ),
              tags: board.tags || [],
              lastPostTimestamp: board.lastPostDate
                ? board.lastPostDate.toISOString()
                : null
            }))
          },

          // the rest
          ...webringData.map(ib => ({
            name: ib.name,
            url: ib.url,
            logo: ib.logo,
            boards: ib.boards
          }))
        ],

        extensions: extensionData
      };

      callback(data);
    });
};

/**
 * Gets extension modules as specified in the config.
 *
 * @return {module[]}
 */
const initializeExtensions = () => {
  return config.extensions.reduce((exts, ext) => {
    let extension;
    try {
      extension = require(ext);
    } catch (e) {
      console.warn("[Webring] Extension", ext, "couldn't be imported.");
      console.warn(e);
    }

    if (!("id" in extension)) {
      console.error("[Webring] Extension in", ext, "doesn't have an extension ID. Discarded.");
      return exts;
    }

    try {
      if ("init" in extension) {
        extension.init();
      }
      exts.push(extension);
    } catch (e) {
      console.warn("[Webring] Extension", extension.id, "failed during initialization.");
      console.warn(e);
    }

    return exts;
  }, []);
};

/**
 * Calls a specific method of the given extensions.
 *
 * @param {module[]} exts - The extensions
 * @param {string} fun - The name of the function to call
 * @param {Array} args - The arguments to apply to the function
 * @return {Object} an object with each extension's response indexed by their extension ID.
 *                  If an error is thrown during the hook then it is not added.
 */
const callExtensionHook = (exts, fun, args) => {
  const extensionData = {};

  exts.forEach(ext => {
    if (fun in ext) {
      try {
        extensionData[ext.id] = ext[fun].apply(ext, args);
      } catch (e) {
        console.warn("[Webring] Extension", ext.id, "failed during", fun + ".");
        console.warn(e);
      }
    }
  });

  return extensionData;
};

/**
 * Asks the cluster's master to call extension hooks and return the data.
 * The callback will be called when the data is collected.
 *
 * @param {Object} extensionCallbacks - The extension callbacks object
 * @param {string} fun - The function to be called
 * @param {Array} args - The arguments to call it with
 * @param {function} callback - The callback which will be called when extension data is returned
 */
const queueHook = (extensionCallbacks, fun, args, callback) => {
  if (!cluster.isWorker) {
    console.warn("[Webring] Master attempted to call hook", fun, "by queue?!");
  }

  const hookID = Math.floor(Math.random() * 1000000).toString();

  extensionCallbacks[hookID] = callback;
  process.send({
    upStream: true,
    extensionHook: fun,
    args,
    hookID
  });
};

/**
 * Reads a file containing comments and a list of strings.
 * NOTE: only recommended to use during init because it's synchronous.
 *
 * @param {string} p - The filepath relative to the current dir
 * @return {string[]}
 */
const readListFile = p =>
  new Set(
    fs
      .readFileSync(path.resolve(__dirname, p), {
        flag: "a+"
      })
      .toString()
      .split("\n")
      .filter(l => l && !l.startsWith("#"))
  );

/**
 * Writes to a file the given data.
 *
 * @param {string} path - The filepath relative to the current dir
 * @param {(string[]|Set<string>)} data - The list of lines to write
 * @return {void}
 */
const writeListFile = (p, data) =>
  fs.open(path.resolve(__dirname, p), "w", (err, fd) => {
    if (err) {
      console.error("[Webring] Couldn't open " + p + "!");
      console.error(err);
      fs.close(fd, err => {
        // something's really really wrong
        if (err) throw err;
      });
    } else {
      fs.write(fd, [...data].join("\n"), (err, written) => {
        if (err) {
          console.error("[Webring] Couldn't write " + p + "!");
          console.error(err);
        } else {
          console.info("[Webring] Wrote ", p, " (now", written, "bytes)");
        }
        fs.close(fd, err => {
          // something's really really wrong
          if (err) throw err;
        });
      });
    }
  });

module.exports = {
  engineVersion: "2.3",

  init() {
    // Check if we are supposed to be a daemon first!
    if (require("../../argumentHandler").informedArguments.noDaemon.informed)
      return;

    // the original webring data
    /** @type {(Webring[]|null)} */
    let webringData = null;
    // the normalized webring data
    /** @type {(any[]|null)} */
    let normalizedData = null;
    // the spider cache.
    /** @type {(Set<string>|null)} */
    let spiderCache = cluster.isMaster
      ? readListFile("spider_cache.txt")
      : null;
    // The extension modules. This will only be handled by the cluster master.
    let extensions = null;
    // (Worker only) The extension response callbacks.
    const extensionCallbacks = {};

    // add new routes
    const decideRouting = requestHandler.decideRouting;
    requestHandler.decideRouting = (req, pathName, res, callback) => {
      if (pathName === "/dolphinring.json") {
        queueHook(extensionCallbacks, "webringRequest", [], (extensionData) => {
          generateWebringJSON(req, res, spiderCache, extensionData);
          callback();
        });

        return;
      }

      // internal boards data used by the dropdown
      if (pathName === "/addon.js/webring") {
        res.writeHead("200", miscOps.getHeader("application/json"));

        queueHook(extensionCallbacks, "webringInternalRequest", [], (extensionData) => {
          webringInternal(webringData, extensionData, results => {
            res.write(JSON.stringify(results));

            res.end();
            callback();
          });
        });

        return;
      }

      decideRouting(req, pathName, res, callback);
    };

    miscPages.getBoardCell = (board, language) => {
      const cellTemplate = getTemplates(language).boardsCell;
      const boardUri = common.clean(board.boardUri);

      let cell = '<div class="boardsCell">' + cellTemplate.template;
      cell += "</div>";

      const linkContent =
        (board.ibName ? board.ibName : "") +
        ("/" + boardUri + "/ - ") +
        common.clean(board.boardName);

      // handle board link if it's a webring board
      cell = cell.replace(
        "__linkBoard_href__",
        board.ibName ? board.absPath : "/" + boardUri + "/"
      );
      cell = cell.replace("__linkBoard_inner__", linkContent);

      cell = miscPages.setSimpleBoardCellLabels(
        board,
        cell,
        cellTemplate.removable
      );

      if (board.tags) {
        cell = cell.replace(
          "__labelTags_location__",
          cellTemplate.removable.labelTags
        );

        cell = cell.replace(
          "__labelTags_inner__",
          common.clean(board.tags.join(", "))
        );
      } else {
        cell = cell.replace("__labelTags_location__", "");
      }

      return miscPages.setBoardCellIndicators(
        cell,
        cellTemplate.removable,
        board
      );
    };

    // add webring boards to boards.js
    miscPages.boards = (parameters, boards, pageCount, language) => {
      const template = getTemplates(language).boardsPage;

      const document = miscPages
        .setOverboardLinks(template)
        .replace("__title__", lang(language).titBoards);

      const webringSkip = normalizedData
        ? settings.boardsPerPage * ((parameters.page || 1) - 1)
        : 0;

      // top spaghetti
      return miscPages
        .setBoards(
          boards.concat(
            normalizedData
              ? normalizedData.slice(
                  webringSkip,
                  webringSkip + settings.boardsPerPage
                )
              : []
          ),
          document,
          language
        )
        .replace(
          "__divPages_children__",
          miscPages.getPages(parameters, pageCount)
        );
    };

    // webring updates and sending to workers
    if (cluster.isMaster) {
      // set up extensions
      extensions = initializeExtensions();

      // set up main thread to pull the webring data
      const updateData = () => {
        fetchRemoteWebring(spiderCache, ibs => {
          webringData = ibs;
          normalizedData = normalizeWebrings(ibs);
          Object.values(cluster.workers).forEach(worker => {
            worker.send({
              webringUpdate: true,
              data: webringData,
              normalizedData,
              spiderCache: [...spiderCache]
            });
          });

          callExtensionHook(extensions, "webringFetched", [webringData]);

          console.info("[Webring] Updated webring data");
          writeListFile("spider_cache.txt", spiderCache);
        });
        // update every 15 minutes
        setTimeout(updateData, 15 * 60 * 1000);
      };
      updateData();
    } else {
      if (!webringData)
        process.send({ upStream: true, webringUpdateRequest: true });
    }

    // worker threads get the data from master
    // this is required because lynxchan worker boot is slow
    // enough that the webring remote fetch can outpace
    // worker boot.
    // Also, for some god-forsaken reason I can't attach more than
    // one listener to the workers. Probably because workers haven't
    // booted when this gets called on master. So I have to override
    // the message processor.
    const kernel = require("../../kernel");
    const processTopDownMessage = kernel.processTopDownMessage;
    kernel.processTopDownMessage = message => {
      if (cluster.isMaster && message.webringUpdateRequest) {
        Object.values(cluster.workers).forEach(worker => {
          worker.send({
            webringUpdate: true,
            data: webringData,
            normalizedData,
            spiderCache: [...spiderCache]
          });
        });
        return;
      } else if (cluster.isMaster && message.extensionHook) {
        Object.values(cluster.workers).forEach(worker => {
          const args = ("args" in message) ? message.args : [];

          worker.send({
            extensionHookResponse: message.hookID,
            extensionData: callExtensionHook(extensions, message.extensionHook, args)
          });
        });
        return;

      } else if (cluster.isWorker && message.webringUpdate) {
        webringData = message.data;
        normalizedData = message.normalizedData;
        spiderCache = new Set(message.spiderCache);
        return;
      } else if (cluster.isWorker && message.extensionHookResponse) {
        const id = message.extensionHookResponse;
        if (id in extensionCallbacks) {
          extensionCallbacks[id](message.extensionData);
        }
        delete extensionCallbacks[id];
        return;
      }

      processTopDownMessage(message);
    };

    // update the last post time for board.
    const postingCommon = require("../../engine/postingOps/common");
    const addPostToStats = postingCommon.addPostToStats;
    postingCommon.addPostToStats = (ip, boardUri, callback) => {
      boards
        .findOneAndUpdate(
          {
            boardUri
          },
          {
            $set: {
              lastPostDate: new Date()
            }
          }
        )
        .then(() => addPostToStats(ip, boardUri, callback));
    };
  }
};

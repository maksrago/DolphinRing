'use strict';

module.exports = {
  url: "https://16chan.xyz", // The domain of your imageboard without the trailing slash.
  // If your imageboard root is under a directory, add it as a prefix as well.

  following: [ // A list of dolphinring.json paths that you want to directly get new nodes from.
    "https://oceanchan.xyz/dolphinring.json",
    "https://16chan.xyz/dolphinring.json",
    "https://onee.ch/dolphinring.json",
    "https://nordchan.net/dolphinring.json",
    "https://spacechan.xyz/dolphinring.json"
  ],

  logos: [ // A list of logos for your imageboard. It might be displayed alongside your imageboard in a Webring display.
    "https://16chan.xyz/.static/favicon.ico"
  ],

  // A list of blacklisted patterns which, if a node matches,
  // the Webring addon will not consider.
  blacklist: new Set([
  ]),

  // A list of extension module files. You can use an absolute or relative path to the JS file (relative from the Webring addon).
  // If relative, the file path should start with ./
  extensions: [
  ]
};

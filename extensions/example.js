'use strict';

module.exports = {
  // The module ID, unique among other webring extensions. If you are porting
  // another webring extension, ID should be the same.
  id: "example",

  // This function will be called during LynxChan startup.
  init() {
    console.log("Hello world! This is an example extension.");
  },

  // This function will be called after a webring update is complete. You can
  // gather data from other nodes with the same extension in this function.
  // The argument is an array of Webring objects (the definition of which is
  // in index.js).
  webringFetched(webringData) {
    console.log(
      webringData.reduce((acc, ib) => {
        if ("example" in ib.extensions) {
          acc++;
        }
        return acc;
      }, 0),
      "imageboards have the 'example' extension webring enabled."
    );
  },

  // This function will be called when /dolphinring.json is requested. The return
  // value of this function will be added verbatim to the webring data.
  webringRequest() {
    return "Hello world!";
  },

  // This function will be called when /addon.js/webring is requested.
  // You can use this function to provide data specific to the current imageboard,
  // i.e. to be used by a front-end script.
  webringInternalRequest() {
    return { "working": true };
  }
};

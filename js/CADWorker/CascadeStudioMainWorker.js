// Define the persistent global variables
var oc = null, externalShapes = {}, sceneShapes = [],
  GUIState, fullShapeEdgeHashes = {}, fullShapeFaceHashes = {},
  currentShape;

// Capture Logs and Errors and forward them to the main thread
let realConsoleLog   = console.log;
let realConsoleError = console.error;
console.log = function (message) {
  //postMessage({ type: "log", payload: message });
  setTimeout(() => { postMessage({ type: "log", payload: message }); }, 0);
  realConsoleLog.apply(console, arguments);
};
console.error = function (err, url, line, colno, errorObj) {
  postMessage({ type: "resetWorking" });
  setTimeout(() => {
    err.message = "INTERNAL OPENCASCADE ERROR DURING GENERATE: " + err.message;
    throw err; 
  }, 0);
  
  realConsoleError.apply(console, arguments);
}; // This is actually accessed via worker.onerror in the main thread

// Import the set of scripts we'll need to perform all the CAD operations
importScripts(
  '../../node_modules/three/build/three.min.js',
  './CascadeStudioStandardLibrary.js',
  './CascadeStudioShapeToMesh.js',
  '../../node_modules/opentype.js/dist/opentype.min.js');

// Preload the Various Fonts that are available via Text3D
var preloadedFonts = ['../../fonts/Roboto.ttf',
  '../../fonts/Papyrus.ttf', '../../fonts/Consolas.ttf'];
var fonts = {};
preloadedFonts.forEach((fontURL) => {
  opentype.load(fontURL, function (err, font) {
    if (err) { console.log(err); }
    let fontName = fontURL.split("./fonts/")[1].split(".ttf")[0];
    fonts[fontName] = font;
  });
});

// Load the full Open Cascade Web Assembly Module
var messageHandlers = {};
fetch('https://raw.githack.com/donalffons/opencascade.js/embind/dist/opencascade.wasm.js')
  .then(response => response.text())
  .then((data) => {

    // Patch in an intelligible overload finding mechanism
    data = data.replace('throw new BindingError(name+" has no accessible constructor")', 
      `let message = name + " overload not specified!  Consider using one of these overloads: ";
      let matches = Object.values(registeredPointers).filter((item) => (item.pointerType && item.pointerType.name.includes(legalFunctionName+"_")));
      for(let ii = 0; ii < matches.length; ii++){
        message += matches[ii].pointerType.name.slice(0, -1) + "(" + matches[ii].pointerType.registeredClass.constructor_body.length-1 +  " args), "; //
      }
      throw new BindingError(matches);`); //message.slice(0, -1));

    // Remove this export line from the end so it works in browsers
    data = data.split("export default opencascade;")[0];

    // Import the Javascript from a blob URL
    importScripts(URL.createObjectURL(new Blob([data], { type: 'text/javascript' })));

    new opencascade({
      locateFile(path) {
        if (path.endsWith('.wasm')) {
          return "https://raw.githack.com/donalffons/opencascade.js/embind/dist/opencascade.wasm.wasm";
        }
        return path;
      }
    }).then((openCascade) => {
      // Register the "OpenCascade" WebAssembly Module under the shorthand "oc"
      oc = openCascade;
    
      // Ping Pong Messages Back and Forth based on their registration in messageHandlers
      onmessage = function (e) {
        let response = messageHandlers[e.data.type](e.data.payload);
        if (response) { postMessage({ "type": e.data.type, payload: response }); };
      }
    
      // Initial Evaluation after everything has been loaded...
      postMessage({ type: "startupCallback" });
    });
  });


/** This function evaluates `payload.code` (the contents of the Editor Window)
 *  and sets the GUI State. */
function Evaluate(payload) {
  opNumber = 0; // This keeps track of the progress of the evaluation
  GUIState = payload.GUIState;
  try {
    eval(payload.code);
  } catch (e) {
    setTimeout(() => { throw e; }, 0);
  } finally {
    postMessage({ type: "resetWorking" });
    // Clean Cache; remove unused Objects
    for (let hash in argCache) {
      if (!usedHashes.hasOwnProperty(hash)) { delete argCache[hash]; } }
    usedHashes = {};
  }
}
messageHandlers["Evaluate"] = Evaluate;

/**This function accumulates all the shapes in `sceneShapes` into the `TopoDS_Compound` `currentShape`
 * and converts it to a mesh (and a set of edges) with `ShapeToMesh()`, and sends it off to be rendered. */
function combineAndRenderShapes(payload) {
  // Initialize currentShape as an empty Compound Solid
  currentShape     = new oc.TopoDS_Compound();
  let sceneBuilder = new oc.BRep_Builder();
  sceneBuilder.MakeCompound(currentShape);
  let fullShapeEdgeHashes = {}; let fullShapeFaceHashes = {};
  postMessage({ "type": "Progress", "payload": { "opNumber": opNumber++, "opType": "Combining Shapes" } });

  // If there are sceneShapes, iterate through them and add them to currentShape
  if (sceneShapes.length > 0) {
    for (let shapeInd = 0; shapeInd < sceneShapes.length; shapeInd++) {
      if (!sceneShapes[shapeInd] || !sceneShapes[shapeInd].IsNull || sceneShapes[shapeInd].IsNull()) {
        console.error("Null Shape detected in sceneShapes; skipping: " + JSON.stringify(sceneShapes[shapeInd]));
        continue;
      }
      if (!sceneShapes[shapeInd].ShapeType) {
        console.error("Non-Shape detected in sceneShapes; " +
          "are you sure it is a TopoDS_Shape and not something else that needs to be converted to one?");
        console.error(JSON.stringify(sceneShapes[shapeInd]));
        continue;
      }

      // Scan the edges and faces and add to the edge list
      Object.assign(fullShapeEdgeHashes, ForEachEdge(sceneShapes[shapeInd], (index, edge) => { }));
      ForEachFace(sceneShapes[shapeInd], (index, face) => {
        fullShapeFaceHashes[face.HashCode(100000000)] = index;
      });

      sceneBuilder.Add(currentShape, sceneShapes[shapeInd]);
    }

    // Use ShapeToMesh to output a set of triangulated faces and discretized edges to the 3D Viewport
    postMessage({ "type": "Progress", "payload": { "opNumber": opNumber++, "opType": "Triangulating Faces" } });
    let facesAndEdges = ShapeToMesh(currentShape,
      payload.maxDeviation||0.1, fullShapeEdgeHashes, fullShapeFaceHashes);
    sceneShapes = [];
    postMessage({ "type": "Progress", "payload": { "opNumber": opNumber, "opType": "" } }); // Finish the progress
    return facesAndEdges;
  } else {
    console.error("There were no scene shapes returned!");
  }
  postMessage({ "type": "Progress", "payload": { "opNumber": opNumber, "opType": "" } });
}
messageHandlers["combineAndRenderShapes"] = combineAndRenderShapes;

// Import the File IO Utilities
importScripts('./CascadeStudioFileUtils.js');

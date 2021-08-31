const AdmZip = require("adm-zip");
const fs = require("fs");
const util = require("util");
const XmlReader = require("xml-reader");
const xmlQuery = require("xml-query");
const path = require("path");
const Filehound = require("filehound");
const Tiler = require("tiler-arcgis-bundle");

const BUNDLE_DIM = 128; // bundles are 128 rows x 128 columns tiles
const INDEX_SIZE = 5; // tile index is stored in 5 byte values

const WORLD_CIRCUMFERENCE = 40075016.69; // circumference of the earth in metres at the equator
const ORIGIN_OFFSET = WORLD_CIRCUMFERENCE / 2.0; // half the circumference
const TILE_PIXEL_SIZE = 256; // in a map service tileset all tiles are 256x256 pixels

function* enumerate(it, start = 0) {
  let i = start;
  for (const x of it) yield [i++, x];
}

const calculateZoomFromResolution = (
  resolution,
  tile_size = TILE_PIXEL_SIZE
) => {
  return parseInt(
    Math.round(Math.log2(WORLD_CIRCUMFERENCE / (resolution * tile_size)))
  );
};

class TPK {
  constructor(path) {
    const zip = new AdmZip(path);
    zip.extractAllTo("./temp", true);
    const xmlFile = fs.readFileSync("./temp/v101/Map/conf.xml", {
      encoding: "utf8",
    });
    const ast = XmlReader.parseSync(xmlFile);

    this.version = "1.0.0";
    this.attribution = "";

    this.legend = [];

    this.format = xmlQuery(ast).find("CacheTileFormat").text();
    this.cache_xml = xmlQuery(ast).find("TileCacheInfo");
    this.tile_size = xmlQuery(ast).find("TileCols").text();

    // Levels of detail in original TPK (ordinal, starting at 0)
    this.lods = [];
    this.zoom_levels = [];

    xmlQuery(ast)
      .find("LODInfo")
      .each((element) => {
        const lod = xmlQuery(element).find("LevelID").text();
        this.lods.push(lod);

        const resolution = parseFloat(
          xmlQuery(element).find("Resolution").text()
        );
        const zoom_level = calculateZoomFromResolution(
          resolution,
          Number(this.tile_size)
        );
        this.zoom_levels.push(zoom_level);
      });

    const itemInfoXML = fs.readFileSync("./temp/esriinfo/iteminfo.xml", {
      encoding: "utf8",
    });
    const itemInfo = XmlReader.parseSync(itemInfoXML);

    // Descriptive info in esriinfo/iteminfo.xml
    // Some fields are required by ArcGIS to create tile package
    this.name = xmlQuery(itemInfo).find("title").text(); // required field, provided automatically
    this.summary = xmlQuery(itemInfo).find("summary").text(); // required field
    this.tags = xmlQuery(itemInfo).find("tags").text(); // required field
    this.description = xmlQuery(itemInfo).find("description").text(); // optional

    // optional, Credits in ArcGIS
    this.credits = xmlQuery(itemInfo).find("accessinformation").text();

    // optional, Use Constraints in ArcGIS
    this.use_constraints = xmlQuery(itemInfo).find("licenseinfo").text();

    const servicedescriptionsJSON = fs.readFileSync(
      "./temp/servicedescriptions/mapserver/mapserver.json",
      {
        encoding: "utf8",
      }
    );
    const servicedescriptions = JSON.parse(servicedescriptionsJSON);
    const geoExtent = servicedescriptions.resourceInfo.geoFullExtent;
    this.bounds = [Object.values(geoExtent)];

    // convert to dict for easier access
    let resources = {};
    servicedescriptions.resources.forEach((element) => {
      resources = {
        ...resources,
        [element.name]: element.contents || element.resources,
      };
    });

    if (resources.legend) {
      resources.legend.layers.forEach((element) => {
        const elements = element.legend.map((legend) => ({
          imageData: `data:${legend.contentType};base64,${legend.imageData}`,
          label: this.getLabel(legend),
        }));
        const obj = {
          name: element.layerName,
          elements,
        };
        this.legend.push(obj);
      });
    }
  }

  getLabel = (element) =>
    element.label ||
    (util.isArray(element.values) && element.values.join(", "));

  saveTiles = (zoom = this.zoom_levels) => {
    let ext = this.format.toLowerCase();
    if (ext === "mixed") {
      throw new Error(
        "Mixed format tiles are not supported for export to disk"
      );
    }
    ext = ext.replace(/[0-9]/g, "");
    if (fs.existsSync("./tiles")) {
      fs.unlinkSync("./tiles");
    }
    fs.mkdirSync("./tiles");
    zoom.sort((a, b) => a - b);
    this.readTiles(ext, zoom);
  };

  readTiles = (ext, zoom) => {
    const bundles = [];
    const subdirectories = Filehound.create()
      .path("./temp")
      .match("_alllayers")
      .directory()
      .findSync();
    if (fs.existsSync(subdirectories[0])) {
      const bundlesPath = Filehound.create()
        .path("./temp")
        .ext("bundle")
        .findSync();
      if (bundlesPath.length) {
        bundlesPath.forEach((element) => {
          const parts = element.split("/");
          const lod = parts[parts.length - 2].replace("L", "");
          const z = this.zoom_levels[Number(lod)];
          if (z) {
            bundles.push(element);
          }
        });
      }
    }

    bundles.forEach(async (pathBundle) => {
      // parse filename to determine row / col offset for bundle
      // offsets are in hex
      const bundleName = path.basename(pathBundle, ".bundle");
      const row = bundleName.substr(1, 4).toUpperCase();
      const rowOffset = parseInt(row, 16);

      const col = bundleName.substr(6, 4).toUpperCase();
      const columnOffset = parseInt(col, 16);

      // LOD is derived from name of containing folder
      const parts = pathBundle.split("/");
      const lod = parts[parts.length - 2].replace("L", "");

      // Resolve the ordinal level to zoom level
      const z = this.zoom_levels[Number(lod)];

      // max row and column value allowed at this WTMS zoom level:  (2**zoom_level) - 1
      const max_row_col = (1 << z) - 1;

      let index = 0;
      const max_index = BUNDLE_DIM ** 2;

      const pathToBundle = parts.slice(0, -3).join("/");

      const tiler = new Tiler(pathToBundle, { packSize: 128 });

      const getTile = function (x, y, z) {
        return new Promise((resolve, reject) => {
          tiler.getTile(x, y, z, (err, tile) => {
            if (err) reject(err);
            else resolve(tile);
          });
        });
      };

      while (index < max_index) {
        // x = column (longitude), y = row (latitude)
        const col = Number(Math.floor(parseFloat(index) / BUNDLE_DIM));
        const x = columnOffset + col;
        const y = rowOffset + (index % BUNDLE_DIM);
        try {
          if (0 <= x <= max_row_col && 0 <= y <= max_row_col) {
            const tile = await getTile(x, y, z);
            if (tile.data.length) {
              if (!fs.existsSync(`./tiles/${z}`)) fs.mkdirSync(`./tiles/${z}`);
              if (!fs.existsSync(`./tiles/${z}/${x}`))
                fs.mkdirSync(`./tiles/${z}/${x}`);
              fs.writeFileSync(`./tiles/${z}/${x}/${y}.${ext}`, tile.data);
            }
          }
        } catch (error) {
          console.log(error);
        }
        index += 1;
      }
    });
  };
}

module.exports = TPK;

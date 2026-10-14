// ../src/portal.new.js
import { EmailMessage } from "cloudflare:email";

// node_modules/qrcode-generator/dist/qrcode.mjs
var qrcode = function(typeNumber, errorCorrectionLevel) {
  const PAD0 = 236;
  const PAD1 = 17;
  let _typeNumber = typeNumber;
  const _errorCorrectionLevel = QRErrorCorrectionLevel[errorCorrectionLevel];
  let _modules = null;
  let _moduleCount = 0;
  let _dataCache = null;
  const _dataList = [];
  const _this = {};
  const makeImpl = function(test, maskPattern) {
    _moduleCount = _typeNumber * 4 + 17;
    _modules = (function(moduleCount) {
      const modules = new Array(moduleCount);
      for (let row = 0; row < moduleCount; row += 1) {
        modules[row] = new Array(moduleCount);
        for (let col = 0; col < moduleCount; col += 1) {
          modules[row][col] = null;
        }
      }
      return modules;
    })(_moduleCount);
    setupPositionProbePattern(0, 0);
    setupPositionProbePattern(_moduleCount - 7, 0);
    setupPositionProbePattern(0, _moduleCount - 7);
    setupPositionAdjustPattern();
    setupTimingPattern();
    setupTypeInfo(test, maskPattern);
    if (_typeNumber >= 7) {
      setupTypeNumber(test);
    }
    if (_dataCache == null) {
      _dataCache = createData(_typeNumber, _errorCorrectionLevel, _dataList);
    }
    mapData(_dataCache, maskPattern);
  };
  const setupPositionProbePattern = function(row, col) {
    for (let r = -1; r <= 7; r += 1) {
      if (row + r <= -1 || _moduleCount <= row + r) continue;
      for (let c = -1; c <= 7; c += 1) {
        if (col + c <= -1 || _moduleCount <= col + c) continue;
        if (0 <= r && r <= 6 && (c == 0 || c == 6) || 0 <= c && c <= 6 && (r == 0 || r == 6) || 2 <= r && r <= 4 && 2 <= c && c <= 4) {
          _modules[row + r][col + c] = true;
        } else {
          _modules[row + r][col + c] = false;
        }
      }
    }
  };
  const getBestMaskPattern = function() {
    let minLostPoint = 0;
    let pattern = 0;
    for (let i = 0; i < 8; i += 1) {
      makeImpl(true, i);
      const lostPoint = QRUtil.getLostPoint(_this);
      if (i == 0 || minLostPoint > lostPoint) {
        minLostPoint = lostPoint;
        pattern = i;
      }
    }
    return pattern;
  };
  const setupTimingPattern = function() {
    for (let r = 8; r < _moduleCount - 8; r += 1) {
      if (_modules[r][6] != null) {
        continue;
      }
      _modules[r][6] = r % 2 == 0;
    }
    for (let c = 8; c < _moduleCount - 8; c += 1) {
      if (_modules[6][c] != null) {
        continue;
      }
      _modules[6][c] = c % 2 == 0;
    }
  };
  const setupPositionAdjustPattern = function() {
    const pos = QRUtil.getPatternPosition(_typeNumber);
    for (let i = 0; i < pos.length; i += 1) {
      for (let j = 0; j < pos.length; j += 1) {
        const row = pos[i];
        const col = pos[j];
        if (_modules[row][col] != null) {
          continue;
        }
        for (let r = -2; r <= 2; r += 1) {
          for (let c = -2; c <= 2; c += 1) {
            if (r == -2 || r == 2 || c == -2 || c == 2 || r == 0 && c == 0) {
              _modules[row + r][col + c] = true;
            } else {
              _modules[row + r][col + c] = false;
            }
          }
        }
      }
    }
  };
  const setupTypeNumber = function(test) {
    const bits = QRUtil.getBCHTypeNumber(_typeNumber);
    for (let i = 0; i < 18; i += 1) {
      const mod = !test && (bits >> i & 1) == 1;
      _modules[Math.floor(i / 3)][i % 3 + _moduleCount - 8 - 3] = mod;
    }
    for (let i = 0; i < 18; i += 1) {
      const mod = !test && (bits >> i & 1) == 1;
      _modules[i % 3 + _moduleCount - 8 - 3][Math.floor(i / 3)] = mod;
    }
  };
  const setupTypeInfo = function(test, maskPattern) {
    const data = _errorCorrectionLevel << 3 | maskPattern;
    const bits = QRUtil.getBCHTypeInfo(data);
    for (let i = 0; i < 15; i += 1) {
      const mod = !test && (bits >> i & 1) == 1;
      if (i < 6) {
        _modules[i][8] = mod;
      } else if (i < 8) {
        _modules[i + 1][8] = mod;
      } else {
        _modules[_moduleCount - 15 + i][8] = mod;
      }
    }
    for (let i = 0; i < 15; i += 1) {
      const mod = !test && (bits >> i & 1) == 1;
      if (i < 8) {
        _modules[8][_moduleCount - i - 1] = mod;
      } else if (i < 9) {
        _modules[8][15 - i - 1 + 1] = mod;
      } else {
        _modules[8][15 - i - 1] = mod;
      }
    }
    _modules[_moduleCount - 8][8] = !test;
  };
  const mapData = function(data, maskPattern) {
    let inc = -1;
    let row = _moduleCount - 1;
    let bitIndex = 7;
    let byteIndex = 0;
    const maskFunc = QRUtil.getMaskFunction(maskPattern);
    for (let col = _moduleCount - 1; col > 0; col -= 2) {
      if (col == 6) col -= 1;
      while (true) {
        for (let c = 0; c < 2; c += 1) {
          if (_modules[row][col - c] == null) {
            let dark = false;
            if (byteIndex < data.length) {
              dark = (data[byteIndex] >>> bitIndex & 1) == 1;
            }
            const mask = maskFunc(row, col - c);
            if (mask) {
              dark = !dark;
            }
            _modules[row][col - c] = dark;
            bitIndex -= 1;
            if (bitIndex == -1) {
              byteIndex += 1;
              bitIndex = 7;
            }
          }
        }
        row += inc;
        if (row < 0 || _moduleCount <= row) {
          row -= inc;
          inc = -inc;
          break;
        }
      }
    }
  };
  const createBytes = function(buffer, rsBlocks) {
    let offset = 0;
    let maxDcCount = 0;
    let maxEcCount = 0;
    const dcdata = new Array(rsBlocks.length);
    const ecdata = new Array(rsBlocks.length);
    for (let r = 0; r < rsBlocks.length; r += 1) {
      const dcCount = rsBlocks[r].dataCount;
      const ecCount = rsBlocks[r].totalCount - dcCount;
      maxDcCount = Math.max(maxDcCount, dcCount);
      maxEcCount = Math.max(maxEcCount, ecCount);
      dcdata[r] = new Array(dcCount);
      for (let i = 0; i < dcdata[r].length; i += 1) {
        dcdata[r][i] = 255 & buffer.getBuffer()[i + offset];
      }
      offset += dcCount;
      const rsPoly = QRUtil.getErrorCorrectPolynomial(ecCount);
      const rawPoly = qrPolynomial(dcdata[r], rsPoly.getLength() - 1);
      const modPoly = rawPoly.mod(rsPoly);
      ecdata[r] = new Array(rsPoly.getLength() - 1);
      for (let i = 0; i < ecdata[r].length; i += 1) {
        const modIndex = i + modPoly.getLength() - ecdata[r].length;
        ecdata[r][i] = modIndex >= 0 ? modPoly.getAt(modIndex) : 0;
      }
    }
    let totalCodeCount = 0;
    for (let i = 0; i < rsBlocks.length; i += 1) {
      totalCodeCount += rsBlocks[i].totalCount;
    }
    const data = new Array(totalCodeCount);
    let index = 0;
    for (let i = 0; i < maxDcCount; i += 1) {
      for (let r = 0; r < rsBlocks.length; r += 1) {
        if (i < dcdata[r].length) {
          data[index] = dcdata[r][i];
          index += 1;
        }
      }
    }
    for (let i = 0; i < maxEcCount; i += 1) {
      for (let r = 0; r < rsBlocks.length; r += 1) {
        if (i < ecdata[r].length) {
          data[index] = ecdata[r][i];
          index += 1;
        }
      }
    }
    return data;
  };
  const createData = function(typeNumber2, errorCorrectionLevel2, dataList) {
    const rsBlocks = QRRSBlock.getRSBlocks(typeNumber2, errorCorrectionLevel2);
    const buffer = qrBitBuffer();
    for (let i = 0; i < dataList.length; i += 1) {
      const data = dataList[i];
      buffer.put(data.getMode(), 4);
      buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber2));
      data.write(buffer);
    }
    let totalDataCount = 0;
    for (let i = 0; i < rsBlocks.length; i += 1) {
      totalDataCount += rsBlocks[i].dataCount;
    }
    if (buffer.getLengthInBits() > totalDataCount * 8) {
      throw "code length overflow. (" + buffer.getLengthInBits() + ">" + totalDataCount * 8 + ")";
    }
    if (buffer.getLengthInBits() + 4 <= totalDataCount * 8) {
      buffer.put(0, 4);
    }
    while (buffer.getLengthInBits() % 8 != 0) {
      buffer.putBit(false);
    }
    while (true) {
      if (buffer.getLengthInBits() >= totalDataCount * 8) {
        break;
      }
      buffer.put(PAD0, 8);
      if (buffer.getLengthInBits() >= totalDataCount * 8) {
        break;
      }
      buffer.put(PAD1, 8);
    }
    return createBytes(buffer, rsBlocks);
  };
  _this.addData = function(data, mode) {
    mode = mode || "Byte";
    let newData = null;
    switch (mode) {
      case "Numeric":
        newData = qrNumber(data);
        break;
      case "Alphanumeric":
        newData = qrAlphaNum(data);
        break;
      case "Byte":
        newData = qr8BitByte(data);
        break;
      case "Kanji":
        newData = qrKanji(data);
        break;
      default:
        throw "mode:" + mode;
    }
    _dataList.push(newData);
    _dataCache = null;
  };
  _this.isDark = function(row, col) {
    if (row < 0 || _moduleCount <= row || col < 0 || _moduleCount <= col) {
      throw row + "," + col;
    }
    return _modules[row][col];
  };
  _this.getModuleCount = function() {
    return _moduleCount;
  };
  _this.make = function() {
    if (_typeNumber < 1) {
      let typeNumber2 = 1;
      for (; typeNumber2 < 40; typeNumber2++) {
        const rsBlocks = QRRSBlock.getRSBlocks(typeNumber2, _errorCorrectionLevel);
        const buffer = qrBitBuffer();
        for (let i = 0; i < _dataList.length; i++) {
          const data = _dataList[i];
          buffer.put(data.getMode(), 4);
          buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber2));
          data.write(buffer);
        }
        let totalDataCount = 0;
        for (let i = 0; i < rsBlocks.length; i++) {
          totalDataCount += rsBlocks[i].dataCount;
        }
        if (buffer.getLengthInBits() <= totalDataCount * 8) {
          break;
        }
      }
      _typeNumber = typeNumber2;
    }
    makeImpl(false, getBestMaskPattern());
  };
  _this.createTableTag = function(cellSize, margin) {
    cellSize = cellSize || 2;
    margin = typeof margin == "undefined" ? cellSize * 4 : margin;
    let qrHtml = "";
    qrHtml += '<table style="';
    qrHtml += " border-width: 0px; border-style: none;";
    qrHtml += " border-collapse: collapse;";
    qrHtml += " padding: 0px; margin: " + margin + "px;";
    qrHtml += '">';
    qrHtml += "<tbody>";
    for (let r = 0; r < _this.getModuleCount(); r += 1) {
      qrHtml += "<tr>";
      for (let c = 0; c < _this.getModuleCount(); c += 1) {
        qrHtml += '<td style="';
        qrHtml += " border-width: 0px; border-style: none;";
        qrHtml += " border-collapse: collapse;";
        qrHtml += " padding: 0px; margin: 0px;";
        qrHtml += " width: " + cellSize + "px;";
        qrHtml += " height: " + cellSize + "px;";
        qrHtml += " background-color: ";
        qrHtml += _this.isDark(r, c) ? "#000000" : "#ffffff";
        qrHtml += ";";
        qrHtml += '"/>';
      }
      qrHtml += "</tr>";
    }
    qrHtml += "</tbody>";
    qrHtml += "</table>";
    return qrHtml;
  };
  _this.createSvgTag = function(cellSize, margin, alt, title) {
    let opts = {};
    if (typeof arguments[0] == "object") {
      opts = arguments[0];
      cellSize = opts.cellSize;
      margin = opts.margin;
      alt = opts.alt;
      title = opts.title;
    }
    cellSize = cellSize || 2;
    margin = typeof margin == "undefined" ? cellSize * 4 : margin;
    alt = typeof alt === "string" ? { text: alt } : alt || {};
    alt.text = alt.text || null;
    alt.id = alt.text ? alt.id || "qrcode-description" : null;
    title = typeof title === "string" ? { text: title } : title || {};
    title.text = title.text || null;
    title.id = title.text ? title.id || "qrcode-title" : null;
    const size = _this.getModuleCount() * cellSize + margin * 2;
    let c, mc, r, mr, qrSvg2 = "", rect;
    rect = "l" + cellSize + ",0 0," + cellSize + " -" + cellSize + ",0 0,-" + cellSize + "z ";
    qrSvg2 += '<svg version="1.1" xmlns="http://www.w3.org/2000/svg"';
    qrSvg2 += !opts.scalable ? ' width="' + size + 'px" height="' + size + 'px"' : "";
    qrSvg2 += ' viewBox="0 0 ' + size + " " + size + '" ';
    qrSvg2 += ' preserveAspectRatio="xMinYMin meet"';
    qrSvg2 += title.text || alt.text ? ' role="img" aria-labelledby="' + escapeXml([title.id, alt.id].join(" ").trim()) + '"' : "";
    qrSvg2 += ">";
    qrSvg2 += title.text ? '<title id="' + escapeXml(title.id) + '">' + escapeXml(title.text) + "</title>" : "";
    qrSvg2 += alt.text ? '<description id="' + escapeXml(alt.id) + '">' + escapeXml(alt.text) + "</description>" : "";
    qrSvg2 += '<rect width="100%" height="100%" fill="white" cx="0" cy="0"/>';
    qrSvg2 += '<path d="';
    for (r = 0; r < _this.getModuleCount(); r += 1) {
      mr = r * cellSize + margin;
      for (c = 0; c < _this.getModuleCount(); c += 1) {
        if (_this.isDark(r, c)) {
          mc = c * cellSize + margin;
          qrSvg2 += "M" + mc + "," + mr + rect;
        }
      }
    }
    qrSvg2 += '" stroke="transparent" fill="black"/>';
    qrSvg2 += "</svg>";
    return qrSvg2;
  };
  _this.createDataURL = function(cellSize, margin) {
    cellSize = cellSize || 2;
    margin = typeof margin == "undefined" ? cellSize * 4 : margin;
    const size = _this.getModuleCount() * cellSize + margin * 2;
    const min = margin;
    const max = size - margin;
    return createDataURL(size, size, function(x, y) {
      if (min <= x && x < max && min <= y && y < max) {
        const c = Math.floor((x - min) / cellSize);
        const r = Math.floor((y - min) / cellSize);
        return _this.isDark(r, c) ? 0 : 1;
      } else {
        return 1;
      }
    });
  };
  _this.createImgTag = function(cellSize, margin, alt) {
    cellSize = cellSize || 2;
    margin = typeof margin == "undefined" ? cellSize * 4 : margin;
    const size = _this.getModuleCount() * cellSize + margin * 2;
    let img = "";
    img += "<img";
    img += ' src="';
    img += _this.createDataURL(cellSize, margin);
    img += '"';
    img += ' width="';
    img += size;
    img += '"';
    img += ' height="';
    img += size;
    img += '"';
    if (alt) {
      img += ' alt="';
      img += escapeXml(alt);
      img += '"';
    }
    img += "/>";
    return img;
  };
  const escapeXml = function(s) {
    let escaped = "";
    for (let i = 0; i < s.length; i += 1) {
      const c = s.charAt(i);
      switch (c) {
        case "<":
          escaped += "&lt;";
          break;
        case ">":
          escaped += "&gt;";
          break;
        case "&":
          escaped += "&amp;";
          break;
        case '"':
          escaped += "&quot;";
          break;
        default:
          escaped += c;
          break;
      }
    }
    return escaped;
  };
  const _createHalfASCII = function(margin) {
    const cellSize = 1;
    margin = typeof margin == "undefined" ? cellSize * 2 : margin;
    const size = _this.getModuleCount() * cellSize + margin * 2;
    const min = margin;
    const max = size - margin;
    let y, x, r1, r2, p;
    const blocks = {
      "\u2588\u2588": "\u2588",
      "\u2588 ": "\u2580",
      " \u2588": "\u2584",
      "  ": " "
    };
    const blocksLastLineNoMargin = {
      "\u2588\u2588": "\u2580",
      "\u2588 ": "\u2580",
      " \u2588": " ",
      "  ": " "
    };
    let ascii = "";
    for (y = 0; y < size; y += 2) {
      r1 = Math.floor((y - min) / cellSize);
      r2 = Math.floor((y + 1 - min) / cellSize);
      for (x = 0; x < size; x += 1) {
        p = "\u2588";
        if (min <= x && x < max && min <= y && y < max && _this.isDark(r1, Math.floor((x - min) / cellSize))) {
          p = " ";
        }
        if (min <= x && x < max && min <= y + 1 && y + 1 < max && _this.isDark(r2, Math.floor((x - min) / cellSize))) {
          p += " ";
        } else {
          p += "\u2588";
        }
        ascii += margin < 1 && y + 1 >= max ? blocksLastLineNoMargin[p] : blocks[p];
      }
      ascii += "\n";
    }
    if (size % 2 && margin > 0) {
      return ascii.substring(0, ascii.length - size - 1) + Array(size + 1).join("\u2580");
    }
    return ascii.substring(0, ascii.length - 1);
  };
  _this.createASCII = function(cellSize, margin) {
    cellSize = cellSize || 1;
    if (cellSize < 2) {
      return _createHalfASCII(margin);
    }
    cellSize -= 1;
    margin = typeof margin == "undefined" ? cellSize * 2 : margin;
    const size = _this.getModuleCount() * cellSize + margin * 2;
    const min = margin;
    const max = size - margin;
    let y, x, r, p;
    const white = Array(cellSize + 1).join("\u2588\u2588");
    const black = Array(cellSize + 1).join("  ");
    let ascii = "";
    let line = "";
    for (y = 0; y < size; y += 1) {
      r = Math.floor((y - min) / cellSize);
      line = "";
      for (x = 0; x < size; x += 1) {
        p = 1;
        if (min <= x && x < max && min <= y && y < max && _this.isDark(r, Math.floor((x - min) / cellSize))) {
          p = 0;
        }
        line += p ? white : black;
      }
      for (r = 0; r < cellSize; r += 1) {
        ascii += line + "\n";
      }
    }
    return ascii.substring(0, ascii.length - 1);
  };
  _this.renderTo2dContext = function(context, cellSize) {
    cellSize = cellSize || 2;
    const length = _this.getModuleCount();
    for (let row = 0; row < length; row++) {
      for (let col = 0; col < length; col++) {
        context.fillStyle = _this.isDark(row, col) ? "black" : "white";
        context.fillRect(col * cellSize, row * cellSize, cellSize, cellSize);
      }
    }
  };
  return _this;
};
qrcode.stringToBytes = function(s) {
  const bytes = [];
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    bytes.push(c & 255);
  }
  return bytes;
};
qrcode.createStringToBytes = function(unicodeData, numChars) {
  const unicodeMap = (function() {
    const bin = base64DecodeInputStream(unicodeData);
    const read = function() {
      const b = bin.read();
      if (b == -1) throw "eof";
      return b;
    };
    let count = 0;
    const unicodeMap2 = {};
    while (true) {
      const b0 = bin.read();
      if (b0 == -1) break;
      const b1 = read();
      const b2 = read();
      const b3 = read();
      const k = String.fromCharCode(b0 << 8 | b1);
      const v = b2 << 8 | b3;
      unicodeMap2[k] = v;
      count += 1;
    }
    if (count != numChars) {
      throw count + " != " + numChars;
    }
    return unicodeMap2;
  })();
  const unknownChar = "?".charCodeAt(0);
  return function(s) {
    const bytes = [];
    for (let i = 0; i < s.length; i += 1) {
      const c = s.charCodeAt(i);
      if (c < 128) {
        bytes.push(c);
      } else {
        const b = unicodeMap[s.charAt(i)];
        if (typeof b == "number") {
          if ((b & 255) == b) {
            bytes.push(b);
          } else {
            bytes.push(b >>> 8);
            bytes.push(b & 255);
          }
        } else {
          bytes.push(unknownChar);
        }
      }
    }
    return bytes;
  };
};
var QRMode = {
  MODE_NUMBER: 1 << 0,
  MODE_ALPHA_NUM: 1 << 1,
  MODE_8BIT_BYTE: 1 << 2,
  MODE_KANJI: 1 << 3
};
var QRErrorCorrectionLevel = {
  L: 1,
  M: 0,
  Q: 3,
  H: 2
};
var QRMaskPattern = {
  PATTERN000: 0,
  PATTERN001: 1,
  PATTERN010: 2,
  PATTERN011: 3,
  PATTERN100: 4,
  PATTERN101: 5,
  PATTERN110: 6,
  PATTERN111: 7
};
var QRUtil = (function() {
  const PATTERN_POSITION_TABLE = [
    [],
    [6, 18],
    [6, 22],
    [6, 26],
    [6, 30],
    [6, 34],
    [6, 22, 38],
    [6, 24, 42],
    [6, 26, 46],
    [6, 28, 50],
    [6, 30, 54],
    [6, 32, 58],
    [6, 34, 62],
    [6, 26, 46, 66],
    [6, 26, 48, 70],
    [6, 26, 50, 74],
    [6, 30, 54, 78],
    [6, 30, 56, 82],
    [6, 30, 58, 86],
    [6, 34, 62, 90],
    [6, 28, 50, 72, 94],
    [6, 26, 50, 74, 98],
    [6, 30, 54, 78, 102],
    [6, 28, 54, 80, 106],
    [6, 32, 58, 84, 110],
    [6, 30, 58, 86, 114],
    [6, 34, 62, 90, 118],
    [6, 26, 50, 74, 98, 122],
    [6, 30, 54, 78, 102, 126],
    [6, 26, 52, 78, 104, 130],
    [6, 30, 56, 82, 108, 134],
    [6, 34, 60, 86, 112, 138],
    [6, 30, 58, 86, 114, 142],
    [6, 34, 62, 90, 118, 146],
    [6, 30, 54, 78, 102, 126, 150],
    [6, 24, 50, 76, 102, 128, 154],
    [6, 28, 54, 80, 106, 132, 158],
    [6, 32, 58, 84, 110, 136, 162],
    [6, 26, 54, 82, 110, 138, 166],
    [6, 30, 58, 86, 114, 142, 170]
  ];
  const G15 = 1 << 10 | 1 << 8 | 1 << 5 | 1 << 4 | 1 << 2 | 1 << 1 | 1 << 0;
  const G18 = 1 << 12 | 1 << 11 | 1 << 10 | 1 << 9 | 1 << 8 | 1 << 5 | 1 << 2 | 1 << 0;
  const G15_MASK = 1 << 14 | 1 << 12 | 1 << 10 | 1 << 4 | 1 << 1;
  const _this = {};
  const getBCHDigit = function(data) {
    let digit = 0;
    while (data != 0) {
      digit += 1;
      data >>>= 1;
    }
    return digit;
  };
  _this.getBCHTypeInfo = function(data) {
    let d = data << 10;
    while (getBCHDigit(d) - getBCHDigit(G15) >= 0) {
      d ^= G15 << getBCHDigit(d) - getBCHDigit(G15);
    }
    return (data << 10 | d) ^ G15_MASK;
  };
  _this.getBCHTypeNumber = function(data) {
    let d = data << 12;
    while (getBCHDigit(d) - getBCHDigit(G18) >= 0) {
      d ^= G18 << getBCHDigit(d) - getBCHDigit(G18);
    }
    return data << 12 | d;
  };
  _this.getPatternPosition = function(typeNumber) {
    return PATTERN_POSITION_TABLE[typeNumber - 1];
  };
  _this.getMaskFunction = function(maskPattern) {
    switch (maskPattern) {
      case QRMaskPattern.PATTERN000:
        return function(i, j) {
          return (i + j) % 2 == 0;
        };
      case QRMaskPattern.PATTERN001:
        return function(i, j) {
          return i % 2 == 0;
        };
      case QRMaskPattern.PATTERN010:
        return function(i, j) {
          return j % 3 == 0;
        };
      case QRMaskPattern.PATTERN011:
        return function(i, j) {
          return (i + j) % 3 == 0;
        };
      case QRMaskPattern.PATTERN100:
        return function(i, j) {
          return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 == 0;
        };
      case QRMaskPattern.PATTERN101:
        return function(i, j) {
          return i * j % 2 + i * j % 3 == 0;
        };
      case QRMaskPattern.PATTERN110:
        return function(i, j) {
          return (i * j % 2 + i * j % 3) % 2 == 0;
        };
      case QRMaskPattern.PATTERN111:
        return function(i, j) {
          return (i * j % 3 + (i + j) % 2) % 2 == 0;
        };
      default:
        throw "bad maskPattern:" + maskPattern;
    }
  };
  _this.getErrorCorrectPolynomial = function(errorCorrectLength) {
    let a = qrPolynomial([1], 0);
    for (let i = 0; i < errorCorrectLength; i += 1) {
      a = a.multiply(qrPolynomial([1, QRMath.gexp(i)], 0));
    }
    return a;
  };
  _this.getLengthInBits = function(mode, type) {
    if (1 <= type && type < 10) {
      switch (mode) {
        case QRMode.MODE_NUMBER:
          return 10;
        case QRMode.MODE_ALPHA_NUM:
          return 9;
        case QRMode.MODE_8BIT_BYTE:
          return 8;
        case QRMode.MODE_KANJI:
          return 8;
        default:
          throw "mode:" + mode;
      }
    } else if (type < 27) {
      switch (mode) {
        case QRMode.MODE_NUMBER:
          return 12;
        case QRMode.MODE_ALPHA_NUM:
          return 11;
        case QRMode.MODE_8BIT_BYTE:
          return 16;
        case QRMode.MODE_KANJI:
          return 10;
        default:
          throw "mode:" + mode;
      }
    } else if (type < 41) {
      switch (mode) {
        case QRMode.MODE_NUMBER:
          return 14;
        case QRMode.MODE_ALPHA_NUM:
          return 13;
        case QRMode.MODE_8BIT_BYTE:
          return 16;
        case QRMode.MODE_KANJI:
          return 12;
        default:
          throw "mode:" + mode;
      }
    } else {
      throw "type:" + type;
    }
  };
  _this.getLostPoint = function(qrcode2) {
    const moduleCount = qrcode2.getModuleCount();
    let lostPoint = 0;
    for (let row = 0; row < moduleCount; row += 1) {
      for (let col = 0; col < moduleCount; col += 1) {
        let sameCount = 0;
        const dark = qrcode2.isDark(row, col);
        for (let r = -1; r <= 1; r += 1) {
          if (row + r < 0 || moduleCount <= row + r) {
            continue;
          }
          for (let c = -1; c <= 1; c += 1) {
            if (col + c < 0 || moduleCount <= col + c) {
              continue;
            }
            if (r == 0 && c == 0) {
              continue;
            }
            if (dark == qrcode2.isDark(row + r, col + c)) {
              sameCount += 1;
            }
          }
        }
        if (sameCount > 5) {
          lostPoint += 3 + sameCount - 5;
        }
      }
    }
    ;
    for (let row = 0; row < moduleCount - 1; row += 1) {
      for (let col = 0; col < moduleCount - 1; col += 1) {
        let count = 0;
        if (qrcode2.isDark(row, col)) count += 1;
        if (qrcode2.isDark(row + 1, col)) count += 1;
        if (qrcode2.isDark(row, col + 1)) count += 1;
        if (qrcode2.isDark(row + 1, col + 1)) count += 1;
        if (count == 0 || count == 4) {
          lostPoint += 3;
        }
      }
    }
    for (let row = 0; row < moduleCount; row += 1) {
      for (let col = 0; col < moduleCount - 6; col += 1) {
        if (qrcode2.isDark(row, col) && !qrcode2.isDark(row, col + 1) && qrcode2.isDark(row, col + 2) && qrcode2.isDark(row, col + 3) && qrcode2.isDark(row, col + 4) && !qrcode2.isDark(row, col + 5) && qrcode2.isDark(row, col + 6)) {
          lostPoint += 40;
        }
      }
    }
    for (let col = 0; col < moduleCount; col += 1) {
      for (let row = 0; row < moduleCount - 6; row += 1) {
        if (qrcode2.isDark(row, col) && !qrcode2.isDark(row + 1, col) && qrcode2.isDark(row + 2, col) && qrcode2.isDark(row + 3, col) && qrcode2.isDark(row + 4, col) && !qrcode2.isDark(row + 5, col) && qrcode2.isDark(row + 6, col)) {
          lostPoint += 40;
        }
      }
    }
    let darkCount = 0;
    for (let col = 0; col < moduleCount; col += 1) {
      for (let row = 0; row < moduleCount; row += 1) {
        if (qrcode2.isDark(row, col)) {
          darkCount += 1;
        }
      }
    }
    const ratio = Math.abs(100 * darkCount / moduleCount / moduleCount - 50) / 5;
    lostPoint += ratio * 10;
    return lostPoint;
  };
  return _this;
})();
var QRMath = (function() {
  const EXP_TABLE = new Array(256);
  const LOG_TABLE = new Array(256);
  for (let i = 0; i < 8; i += 1) {
    EXP_TABLE[i] = 1 << i;
  }
  for (let i = 8; i < 256; i += 1) {
    EXP_TABLE[i] = EXP_TABLE[i - 4] ^ EXP_TABLE[i - 5] ^ EXP_TABLE[i - 6] ^ EXP_TABLE[i - 8];
  }
  for (let i = 0; i < 255; i += 1) {
    LOG_TABLE[EXP_TABLE[i]] = i;
  }
  const _this = {};
  _this.glog = function(n) {
    if (n < 1) {
      throw "glog(" + n + ")";
    }
    return LOG_TABLE[n];
  };
  _this.gexp = function(n) {
    while (n < 0) {
      n += 255;
    }
    while (n >= 256) {
      n -= 255;
    }
    return EXP_TABLE[n];
  };
  return _this;
})();
var qrPolynomial = function(num, shift) {
  if (typeof num.length == "undefined") {
    throw num.length + "/" + shift;
  }
  const _num = (function() {
    let offset = 0;
    while (offset < num.length && num[offset] == 0) {
      offset += 1;
    }
    const _num2 = new Array(num.length - offset + shift);
    for (let i = 0; i < num.length - offset; i += 1) {
      _num2[i] = num[i + offset];
    }
    return _num2;
  })();
  const _this = {};
  _this.getAt = function(index) {
    return _num[index];
  };
  _this.getLength = function() {
    return _num.length;
  };
  _this.multiply = function(e) {
    const num2 = new Array(_this.getLength() + e.getLength() - 1);
    for (let i = 0; i < _this.getLength(); i += 1) {
      for (let j = 0; j < e.getLength(); j += 1) {
        num2[i + j] ^= QRMath.gexp(QRMath.glog(_this.getAt(i)) + QRMath.glog(e.getAt(j)));
      }
    }
    return qrPolynomial(num2, 0);
  };
  _this.mod = function(e) {
    if (_this.getLength() - e.getLength() < 0) {
      return _this;
    }
    const ratio = QRMath.glog(_this.getAt(0)) - QRMath.glog(e.getAt(0));
    const num2 = new Array(_this.getLength());
    for (let i = 0; i < _this.getLength(); i += 1) {
      num2[i] = _this.getAt(i);
    }
    for (let i = 0; i < e.getLength(); i += 1) {
      num2[i] ^= QRMath.gexp(QRMath.glog(e.getAt(i)) + ratio);
    }
    return qrPolynomial(num2, 0).mod(e);
  };
  return _this;
};
var QRRSBlock = (function() {
  const RS_BLOCK_TABLE = [
    // L
    // M
    // Q
    // H
    // 1
    [1, 26, 19],
    [1, 26, 16],
    [1, 26, 13],
    [1, 26, 9],
    // 2
    [1, 44, 34],
    [1, 44, 28],
    [1, 44, 22],
    [1, 44, 16],
    // 3
    [1, 70, 55],
    [1, 70, 44],
    [2, 35, 17],
    [2, 35, 13],
    // 4
    [1, 100, 80],
    [2, 50, 32],
    [2, 50, 24],
    [4, 25, 9],
    // 5
    [1, 134, 108],
    [2, 67, 43],
    [2, 33, 15, 2, 34, 16],
    [2, 33, 11, 2, 34, 12],
    // 6
    [2, 86, 68],
    [4, 43, 27],
    [4, 43, 19],
    [4, 43, 15],
    // 7
    [2, 98, 78],
    [4, 49, 31],
    [2, 32, 14, 4, 33, 15],
    [4, 39, 13, 1, 40, 14],
    // 8
    [2, 121, 97],
    [2, 60, 38, 2, 61, 39],
    [4, 40, 18, 2, 41, 19],
    [4, 40, 14, 2, 41, 15],
    // 9
    [2, 146, 116],
    [3, 58, 36, 2, 59, 37],
    [4, 36, 16, 4, 37, 17],
    [4, 36, 12, 4, 37, 13],
    // 10
    [2, 86, 68, 2, 87, 69],
    [4, 69, 43, 1, 70, 44],
    [6, 43, 19, 2, 44, 20],
    [6, 43, 15, 2, 44, 16],
    // 11
    [4, 101, 81],
    [1, 80, 50, 4, 81, 51],
    [4, 50, 22, 4, 51, 23],
    [3, 36, 12, 8, 37, 13],
    // 12
    [2, 116, 92, 2, 117, 93],
    [6, 58, 36, 2, 59, 37],
    [4, 46, 20, 6, 47, 21],
    [7, 42, 14, 4, 43, 15],
    // 13
    [4, 133, 107],
    [8, 59, 37, 1, 60, 38],
    [8, 44, 20, 4, 45, 21],
    [12, 33, 11, 4, 34, 12],
    // 14
    [3, 145, 115, 1, 146, 116],
    [4, 64, 40, 5, 65, 41],
    [11, 36, 16, 5, 37, 17],
    [11, 36, 12, 5, 37, 13],
    // 15
    [5, 109, 87, 1, 110, 88],
    [5, 65, 41, 5, 66, 42],
    [5, 54, 24, 7, 55, 25],
    [11, 36, 12, 7, 37, 13],
    // 16
    [5, 122, 98, 1, 123, 99],
    [7, 73, 45, 3, 74, 46],
    [15, 43, 19, 2, 44, 20],
    [3, 45, 15, 13, 46, 16],
    // 17
    [1, 135, 107, 5, 136, 108],
    [10, 74, 46, 1, 75, 47],
    [1, 50, 22, 15, 51, 23],
    [2, 42, 14, 17, 43, 15],
    // 18
    [5, 150, 120, 1, 151, 121],
    [9, 69, 43, 4, 70, 44],
    [17, 50, 22, 1, 51, 23],
    [2, 42, 14, 19, 43, 15],
    // 19
    [3, 141, 113, 4, 142, 114],
    [3, 70, 44, 11, 71, 45],
    [17, 47, 21, 4, 48, 22],
    [9, 39, 13, 16, 40, 14],
    // 20
    [3, 135, 107, 5, 136, 108],
    [3, 67, 41, 13, 68, 42],
    [15, 54, 24, 5, 55, 25],
    [15, 43, 15, 10, 44, 16],
    // 21
    [4, 144, 116, 4, 145, 117],
    [17, 68, 42],
    [17, 50, 22, 6, 51, 23],
    [19, 46, 16, 6, 47, 17],
    // 22
    [2, 139, 111, 7, 140, 112],
    [17, 74, 46],
    [7, 54, 24, 16, 55, 25],
    [34, 37, 13],
    // 23
    [4, 151, 121, 5, 152, 122],
    [4, 75, 47, 14, 76, 48],
    [11, 54, 24, 14, 55, 25],
    [16, 45, 15, 14, 46, 16],
    // 24
    [6, 147, 117, 4, 148, 118],
    [6, 73, 45, 14, 74, 46],
    [11, 54, 24, 16, 55, 25],
    [30, 46, 16, 2, 47, 17],
    // 25
    [8, 132, 106, 4, 133, 107],
    [8, 75, 47, 13, 76, 48],
    [7, 54, 24, 22, 55, 25],
    [22, 45, 15, 13, 46, 16],
    // 26
    [10, 142, 114, 2, 143, 115],
    [19, 74, 46, 4, 75, 47],
    [28, 50, 22, 6, 51, 23],
    [33, 46, 16, 4, 47, 17],
    // 27
    [8, 152, 122, 4, 153, 123],
    [22, 73, 45, 3, 74, 46],
    [8, 53, 23, 26, 54, 24],
    [12, 45, 15, 28, 46, 16],
    // 28
    [3, 147, 117, 10, 148, 118],
    [3, 73, 45, 23, 74, 46],
    [4, 54, 24, 31, 55, 25],
    [11, 45, 15, 31, 46, 16],
    // 29
    [7, 146, 116, 7, 147, 117],
    [21, 73, 45, 7, 74, 46],
    [1, 53, 23, 37, 54, 24],
    [19, 45, 15, 26, 46, 16],
    // 30
    [5, 145, 115, 10, 146, 116],
    [19, 75, 47, 10, 76, 48],
    [15, 54, 24, 25, 55, 25],
    [23, 45, 15, 25, 46, 16],
    // 31
    [13, 145, 115, 3, 146, 116],
    [2, 74, 46, 29, 75, 47],
    [42, 54, 24, 1, 55, 25],
    [23, 45, 15, 28, 46, 16],
    // 32
    [17, 145, 115],
    [10, 74, 46, 23, 75, 47],
    [10, 54, 24, 35, 55, 25],
    [19, 45, 15, 35, 46, 16],
    // 33
    [17, 145, 115, 1, 146, 116],
    [14, 74, 46, 21, 75, 47],
    [29, 54, 24, 19, 55, 25],
    [11, 45, 15, 46, 46, 16],
    // 34
    [13, 145, 115, 6, 146, 116],
    [14, 74, 46, 23, 75, 47],
    [44, 54, 24, 7, 55, 25],
    [59, 46, 16, 1, 47, 17],
    // 35
    [12, 151, 121, 7, 152, 122],
    [12, 75, 47, 26, 76, 48],
    [39, 54, 24, 14, 55, 25],
    [22, 45, 15, 41, 46, 16],
    // 36
    [6, 151, 121, 14, 152, 122],
    [6, 75, 47, 34, 76, 48],
    [46, 54, 24, 10, 55, 25],
    [2, 45, 15, 64, 46, 16],
    // 37
    [17, 152, 122, 4, 153, 123],
    [29, 74, 46, 14, 75, 47],
    [49, 54, 24, 10, 55, 25],
    [24, 45, 15, 46, 46, 16],
    // 38
    [4, 152, 122, 18, 153, 123],
    [13, 74, 46, 32, 75, 47],
    [48, 54, 24, 14, 55, 25],
    [42, 45, 15, 32, 46, 16],
    // 39
    [20, 147, 117, 4, 148, 118],
    [40, 75, 47, 7, 76, 48],
    [43, 54, 24, 22, 55, 25],
    [10, 45, 15, 67, 46, 16],
    // 40
    [19, 148, 118, 6, 149, 119],
    [18, 75, 47, 31, 76, 48],
    [34, 54, 24, 34, 55, 25],
    [20, 45, 15, 61, 46, 16]
  ];
  const qrRSBlock = function(totalCount, dataCount) {
    const _this2 = {};
    _this2.totalCount = totalCount;
    _this2.dataCount = dataCount;
    return _this2;
  };
  const _this = {};
  const getRsBlockTable = function(typeNumber, errorCorrectionLevel) {
    switch (errorCorrectionLevel) {
      case QRErrorCorrectionLevel.L:
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 0];
      case QRErrorCorrectionLevel.M:
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 1];
      case QRErrorCorrectionLevel.Q:
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 2];
      case QRErrorCorrectionLevel.H:
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 3];
      default:
        return void 0;
    }
  };
  _this.getRSBlocks = function(typeNumber, errorCorrectionLevel) {
    const rsBlock = getRsBlockTable(typeNumber, errorCorrectionLevel);
    if (typeof rsBlock == "undefined") {
      throw "bad rs block @ typeNumber:" + typeNumber + "/errorCorrectionLevel:" + errorCorrectionLevel;
    }
    const length = rsBlock.length / 3;
    const list = [];
    for (let i = 0; i < length; i += 1) {
      const count = rsBlock[i * 3 + 0];
      const totalCount = rsBlock[i * 3 + 1];
      const dataCount = rsBlock[i * 3 + 2];
      for (let j = 0; j < count; j += 1) {
        list.push(qrRSBlock(totalCount, dataCount));
      }
    }
    return list;
  };
  return _this;
})();
var qrBitBuffer = function() {
  const _buffer = [];
  let _length = 0;
  const _this = {};
  _this.getBuffer = function() {
    return _buffer;
  };
  _this.getAt = function(index) {
    const bufIndex = Math.floor(index / 8);
    return (_buffer[bufIndex] >>> 7 - index % 8 & 1) == 1;
  };
  _this.put = function(num, length) {
    for (let i = 0; i < length; i += 1) {
      _this.putBit((num >>> length - i - 1 & 1) == 1);
    }
  };
  _this.getLengthInBits = function() {
    return _length;
  };
  _this.putBit = function(bit) {
    const bufIndex = Math.floor(_length / 8);
    if (_buffer.length <= bufIndex) {
      _buffer.push(0);
    }
    if (bit) {
      _buffer[bufIndex] |= 128 >>> _length % 8;
    }
    _length += 1;
  };
  return _this;
};
var qrNumber = function(data) {
  const _mode = QRMode.MODE_NUMBER;
  const _data = data;
  const _this = {};
  _this.getMode = function() {
    return _mode;
  };
  _this.getLength = function(buffer) {
    return _data.length;
  };
  _this.write = function(buffer) {
    const data2 = _data;
    let i = 0;
    while (i + 2 < data2.length) {
      buffer.put(strToNum(data2.substring(i, i + 3)), 10);
      i += 3;
    }
    if (i < data2.length) {
      if (data2.length - i == 1) {
        buffer.put(strToNum(data2.substring(i, i + 1)), 4);
      } else if (data2.length - i == 2) {
        buffer.put(strToNum(data2.substring(i, i + 2)), 7);
      }
    }
  };
  const strToNum = function(s) {
    let num = 0;
    for (let i = 0; i < s.length; i += 1) {
      num = num * 10 + chatToNum(s.charAt(i));
    }
    return num;
  };
  const chatToNum = function(c) {
    if ("0" <= c && c <= "9") {
      return c.charCodeAt(0) - "0".charCodeAt(0);
    }
    throw "illegal char :" + c;
  };
  return _this;
};
var qrAlphaNum = function(data) {
  const _mode = QRMode.MODE_ALPHA_NUM;
  const _data = data;
  const _this = {};
  _this.getMode = function() {
    return _mode;
  };
  _this.getLength = function(buffer) {
    return _data.length;
  };
  _this.write = function(buffer) {
    const s = _data;
    let i = 0;
    while (i + 1 < s.length) {
      buffer.put(
        getCode(s.charAt(i)) * 45 + getCode(s.charAt(i + 1)),
        11
      );
      i += 2;
    }
    if (i < s.length) {
      buffer.put(getCode(s.charAt(i)), 6);
    }
  };
  const getCode = function(c) {
    if ("0" <= c && c <= "9") {
      return c.charCodeAt(0) - "0".charCodeAt(0);
    } else if ("A" <= c && c <= "Z") {
      return c.charCodeAt(0) - "A".charCodeAt(0) + 10;
    } else {
      switch (c) {
        case " ":
          return 36;
        case "$":
          return 37;
        case "%":
          return 38;
        case "*":
          return 39;
        case "+":
          return 40;
        case "-":
          return 41;
        case ".":
          return 42;
        case "/":
          return 43;
        case ":":
          return 44;
        default:
          throw "illegal char :" + c;
      }
    }
  };
  return _this;
};
var qr8BitByte = function(data) {
  const _mode = QRMode.MODE_8BIT_BYTE;
  const _data = data;
  const _bytes = qrcode.stringToBytes(data);
  const _this = {};
  _this.getMode = function() {
    return _mode;
  };
  _this.getLength = function(buffer) {
    return _bytes.length;
  };
  _this.write = function(buffer) {
    for (let i = 0; i < _bytes.length; i += 1) {
      buffer.put(_bytes[i], 8);
    }
  };
  return _this;
};
var qrKanji = function(data) {
  const _mode = QRMode.MODE_KANJI;
  const _data = data;
  const stringToBytes2 = qrcode.stringToBytes;
  !(function(c, code) {
    const test = stringToBytes2(c);
    if (test.length != 2 || (test[0] << 8 | test[1]) != code) {
      throw "sjis not supported.";
    }
  })("\u53CB", 38726);
  const _bytes = stringToBytes2(data);
  const _this = {};
  _this.getMode = function() {
    return _mode;
  };
  _this.getLength = function(buffer) {
    return ~~(_bytes.length / 2);
  };
  _this.write = function(buffer) {
    const data2 = _bytes;
    let i = 0;
    while (i + 1 < data2.length) {
      let c = (255 & data2[i]) << 8 | 255 & data2[i + 1];
      if (33088 <= c && c <= 40956) {
        c -= 33088;
      } else if (57408 <= c && c <= 60351) {
        c -= 49472;
      } else {
        throw "illegal char at " + (i + 1) + "/" + c;
      }
      c = (c >>> 8 & 255) * 192 + (c & 255);
      buffer.put(c, 13);
      i += 2;
    }
    if (i < data2.length) {
      throw "illegal char at " + (i + 1);
    }
  };
  return _this;
};
var byteArrayOutputStream = function() {
  const _bytes = [];
  const _this = {};
  _this.writeByte = function(b) {
    _bytes.push(b & 255);
  };
  _this.writeShort = function(i) {
    _this.writeByte(i);
    _this.writeByte(i >>> 8);
  };
  _this.writeBytes = function(b, off, len) {
    off = off || 0;
    len = len || b.length;
    for (let i = 0; i < len; i += 1) {
      _this.writeByte(b[i + off]);
    }
  };
  _this.writeString = function(s) {
    for (let i = 0; i < s.length; i += 1) {
      _this.writeByte(s.charCodeAt(i));
    }
  };
  _this.toByteArray = function() {
    return _bytes;
  };
  _this.toString = function() {
    let s = "";
    s += "[";
    for (let i = 0; i < _bytes.length; i += 1) {
      if (i > 0) {
        s += ",";
      }
      s += _bytes[i];
    }
    s += "]";
    return s;
  };
  return _this;
};
var base64EncodeOutputStream = function() {
  let _buffer = 0;
  let _buflen = 0;
  let _length = 0;
  let _base64 = "";
  const _this = {};
  const writeEncoded = function(b) {
    _base64 += String.fromCharCode(encode(b & 63));
  };
  const encode = function(n) {
    if (n < 0) {
      throw "n:" + n;
    } else if (n < 26) {
      return 65 + n;
    } else if (n < 52) {
      return 97 + (n - 26);
    } else if (n < 62) {
      return 48 + (n - 52);
    } else if (n == 62) {
      return 43;
    } else if (n == 63) {
      return 47;
    } else {
      throw "n:" + n;
    }
  };
  _this.writeByte = function(n) {
    _buffer = _buffer << 8 | n & 255;
    _buflen += 8;
    _length += 1;
    while (_buflen >= 6) {
      writeEncoded(_buffer >>> _buflen - 6);
      _buflen -= 6;
    }
  };
  _this.flush = function() {
    if (_buflen > 0) {
      writeEncoded(_buffer << 6 - _buflen);
      _buffer = 0;
      _buflen = 0;
    }
    if (_length % 3 != 0) {
      const padlen = 3 - _length % 3;
      for (let i = 0; i < padlen; i += 1) {
        _base64 += "=";
      }
    }
  };
  _this.toString = function() {
    return _base64;
  };
  return _this;
};
var base64DecodeInputStream = function(str) {
  const _str = str;
  let _pos = 0;
  let _buffer = 0;
  let _buflen = 0;
  const _this = {};
  _this.read = function() {
    while (_buflen < 8) {
      if (_pos >= _str.length) {
        if (_buflen == 0) {
          return -1;
        }
        throw "unexpected end of file./" + _buflen;
      }
      const c = _str.charAt(_pos);
      _pos += 1;
      if (c == "=") {
        _buflen = 0;
        return -1;
      } else if (c.match(/^\s$/)) {
        continue;
      }
      _buffer = _buffer << 6 | decode(c.charCodeAt(0));
      _buflen += 6;
    }
    const n = _buffer >>> _buflen - 8 & 255;
    _buflen -= 8;
    return n;
  };
  const decode = function(c) {
    if (65 <= c && c <= 90) {
      return c - 65;
    } else if (97 <= c && c <= 122) {
      return c - 97 + 26;
    } else if (48 <= c && c <= 57) {
      return c - 48 + 52;
    } else if (c == 43) {
      return 62;
    } else if (c == 47) {
      return 63;
    } else {
      throw "c:" + c;
    }
  };
  return _this;
};
var gifImage = function(width, height) {
  const _width = width;
  const _height = height;
  const _data = new Array(width * height);
  const _this = {};
  _this.setPixel = function(x, y, pixel) {
    _data[y * _width + x] = pixel;
  };
  _this.write = function(out) {
    out.writeString("GIF87a");
    out.writeShort(_width);
    out.writeShort(_height);
    out.writeByte(128);
    out.writeByte(0);
    out.writeByte(0);
    out.writeByte(0);
    out.writeByte(0);
    out.writeByte(0);
    out.writeByte(255);
    out.writeByte(255);
    out.writeByte(255);
    out.writeString(",");
    out.writeShort(0);
    out.writeShort(0);
    out.writeShort(_width);
    out.writeShort(_height);
    out.writeByte(0);
    const lzwMinCodeSize = 2;
    const raster = getLZWRaster(lzwMinCodeSize);
    out.writeByte(lzwMinCodeSize);
    let offset = 0;
    while (raster.length - offset > 255) {
      out.writeByte(255);
      out.writeBytes(raster, offset, 255);
      offset += 255;
    }
    out.writeByte(raster.length - offset);
    out.writeBytes(raster, offset, raster.length - offset);
    out.writeByte(0);
    out.writeString(";");
  };
  const bitOutputStream = function(out) {
    const _out = out;
    let _bitLength = 0;
    let _bitBuffer = 0;
    const _this2 = {};
    _this2.write = function(data, length) {
      if (data >>> length != 0) {
        throw "length over";
      }
      while (_bitLength + length >= 8) {
        _out.writeByte(255 & (data << _bitLength | _bitBuffer));
        length -= 8 - _bitLength;
        data >>>= 8 - _bitLength;
        _bitBuffer = 0;
        _bitLength = 0;
      }
      _bitBuffer = data << _bitLength | _bitBuffer;
      _bitLength = _bitLength + length;
    };
    _this2.flush = function() {
      if (_bitLength > 0) {
        _out.writeByte(_bitBuffer);
      }
    };
    return _this2;
  };
  const getLZWRaster = function(lzwMinCodeSize) {
    const clearCode = 1 << lzwMinCodeSize;
    const endCode = (1 << lzwMinCodeSize) + 1;
    let bitLength = lzwMinCodeSize + 1;
    const table = lzwTable();
    for (let i = 0; i < clearCode; i += 1) {
      table.add(String.fromCharCode(i));
    }
    table.add(String.fromCharCode(clearCode));
    table.add(String.fromCharCode(endCode));
    const byteOut = byteArrayOutputStream();
    const bitOut = bitOutputStream(byteOut);
    bitOut.write(clearCode, bitLength);
    let dataIndex = 0;
    let s = String.fromCharCode(_data[dataIndex]);
    dataIndex += 1;
    while (dataIndex < _data.length) {
      const c = String.fromCharCode(_data[dataIndex]);
      dataIndex += 1;
      if (table.contains(s + c)) {
        s = s + c;
      } else {
        bitOut.write(table.indexOf(s), bitLength);
        if (table.size() < 4095) {
          if (table.size() == 1 << bitLength) {
            bitLength += 1;
          }
          table.add(s + c);
        }
        s = c;
      }
    }
    bitOut.write(table.indexOf(s), bitLength);
    bitOut.write(endCode, bitLength);
    bitOut.flush();
    return byteOut.toByteArray();
  };
  const lzwTable = function() {
    const _map = {};
    let _size = 0;
    const _this2 = {};
    _this2.add = function(key) {
      if (_this2.contains(key)) {
        throw "dup key:" + key;
      }
      _map[key] = _size;
      _size += 1;
    };
    _this2.size = function() {
      return _size;
    };
    _this2.indexOf = function(key) {
      return _map[key];
    };
    _this2.contains = function(key) {
      return typeof _map[key] != "undefined";
    };
    return _this2;
  };
  return _this;
};
var createDataURL = function(width, height, getPixel) {
  const gif = gifImage(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      gif.setPixel(x, y, getPixel(x, y));
    }
  }
  const b = byteArrayOutputStream();
  gif.write(b);
  const base64 = base64EncodeOutputStream();
  const bytes = b.toByteArray();
  for (let i = 0; i < bytes.length; i += 1) {
    base64.writeByte(bytes[i]);
  }
  base64.flush();
  return "data:image/gif;base64," + base64;
};
var qrcode_default = qrcode;
var stringToBytes = qrcode.stringToBytes;

// ../src/portal.new.js
var portal_new_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let res;
    try {
      res = await handle(request, env, url, ctx);
    } catch (e) {
      res = new Response("error", { status: 500 });
    }
    try {
      if (ctx && ctx.waitUntil && (env.DB || env.LOG)) ctx.waitUntil(logSec(request, env, url, res.status, res.headers.get("x-af") === "1"));
    } catch (e) {
    }
    return res;
  }
};
function fwd(next, request, env) {
  const r = new Request(next, request);
  if (env.SVC_KEY) r.headers.set("x-svc-key", env.SVC_KEY);
  else r.headers.delete("x-svc-key");
  return r;
}
async function handle(request, env, url, ctx) {
  if (url.pathname === "/api/ci-report") {
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    return env.STATUS.fetch(fwd(new URL(request.url), request, env));
  }
  if (url.pathname.startsWith("/g/")) return guestPage(request, env, ctx, url);
  if (url.pathname === "/logout") {
    if (request.method !== "POST") return Response.redirect(new URL("/", url), 303);
    const los = originState(request);
    let loOk = los === "ok";
    if (los === "unknown") {
      try {
        const f = await request.formData();
        loOk = !!gateVal(request) && await ctEq(String(f.get("csrf") || ""), await csrfLogout(env, request));
      } catch (e) {
      }
    }
    if (!loOk) return tfaHtml("\u9000\u51FA\u767B\u5F55", `<div class="tf"><p class="err">\u8BF7\u6C42\u6765\u6E90\u4E0D\u5BF9\uFF0C\u8BF7\u5237\u65B0\u9875\u9762\u91CD\u8BD5\u3002</p><p><a href="/">\u21BB \u56DE\u5230\u5DE5\u4F5C\u53F0\u91CD\u65B0\u70B9\u4E00\u6B21</a></p></div>`, 403);
    const all = url.searchParams.get("all") === "1";
    if (all && await loggedIn(request, env) && env.DB) {
      try {
        await env.DB.prepare("INSERT INTO sess_meta (id, ver, t) VALUES (1, 1, ?1) ON CONFLICT(id) DO UPDATE SET ver = ver + 1, t = excluded.t").bind(Date.now()).run();
      } catch (e) {
      }
      SV = null;
      try {
        await adminLog(env, request, "logout_all");
      } catch (e) {
      }
    }
    return new Response(null, { status: 303, headers: Object.assign({ "location": "/?bye=" + (all ? "all" : "1"), "set-cookie": "gate=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0", "cache-control": "no-store" }, SECH) });
  }
  if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
    if (!await loggedIn(request, env)) {
      if (url.pathname.startsWith("/admin/proxy/sub-url")) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
      return toLogin(url);
    }
    if (!env.ADMIN || !env.ADMIN_SVC_KEY) return new Response("admin not configured", { status: 503 });
    const r = new Request(new URL(request.url), request);
    r.headers.set("x-svc-key", env.ADMIN_SVC_KEY);
    r.headers.set("x-client-co", request.cf && request.cf.country || "");
    return env.ADMIN.fetch(r);
  }
  if (url.pathname === "/api/otp-latest") {
    if (!await loggedIn(request, env)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
    const next = new URL(request.url);
    next.pathname = "/api/latest";
    next.search = "";
    const r = await env.OTP.fetch(fwd(next, request, env));
    let d = null;
    try { d = await r.json(); } catch (e) {}
    if (!r.ok || !d) return new Response(JSON.stringify({ ok: false }), { status: r.ok ? 502 : r.status, headers: Object.assign({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store, private" }, SECH) });
    const OSK = ["noreply@example.com", "alert@panel.example.com"];
    const fr = String(d.from || "").toLowerCase().trim(), sj = String(d.subject || "").trim();
    const age = Number(d.age_ms);
    const show = d.code && d.fresh && Number.isFinite(age) && age <= 6e5 && !OSK.includes(fr) && !sj.startsWith("[\u9762\u677F]") && !sj.startsWith("\u3010\u9762\u677F\u3011");
    const out = show ? { ok: true, id: String(d.id || ""), code: String(d.code), from: d.from, subject: d.subject, received: d.received, age_ms: age, fresh: true } : { ok: true, code: null, fresh: false };
    return new Response(JSON.stringify(out), { status: 200, headers: Object.assign({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store, private" }, SECH) });
  }
  const mail = url.pathname === "/mail" || url.pathname.startsWith("/mail/") || url.pathname === "/api/codes" || url.pathname === "/api/message" || url.pathname === "/api/translate";
  const drive = url.pathname === "/drive" || url.pathname.startsWith("/drive/");
  const status = url.pathname === "/status" || url.pathname.startsWith("/status/");
  if (mail || drive || status) {
    if (!await loggedIn(request, env)) {
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/drive/api/") || url.pathname.startsWith("/status/api/")) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
      return toLogin(url);
    }
    if (status) {
      const next2 = new URL(request.url);
      next2.pathname = url.pathname === "/status" ? "/" : url.pathname.slice(7);
      return env.STATUS.fetch(fwd(next2, request, env));
    }
    if (drive) {
      const next2 = new URL(request.url);
      next2.pathname = url.pathname === "/drive" ? "/" : url.pathname.slice(6);
      return env.DRIVE.fetch(fwd(next2, request, env));
    }
    const next = new URL(request.url);
    if (url.pathname === "/mail") next.pathname = "/";
    else if (url.pathname.startsWith("/mail/")) next.pathname = url.pathname.slice(5);
    return env.OTP.fetch(fwd(next, request, env));
  }
  if (url.pathname === "/2fa") return tfaLoginPage(request, env, ctx, url);
  if (url.pathname === "/2fa/setup") return tfaSetup(request, env, ctx, url);
  if (url.pathname === "/") return portal(request, env, ctx, url);
  const segs = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  const authed = await loggedIn(request, env);
  const PANEL = await panelPath(env);
  if (segs[0] === "login") {
    if (request.method !== "GET" && request.method !== "HEAD") return Response.json({ ok: false, msg: "\u8BF7\u4ECE\u5DE5\u4F5C\u53F0\u767B\u5F55" }, { status: 403, headers: SECH });
    if (authed && PANEL) return Response.redirect(new URL("/" + PANEL, url), 302);
    return Response.redirect(new URL("/", url), 302);
  }
  if (!authed && PANEL && segs[0] === PANEL && segs.length === 1 && request.headers.get("sec-fetch-dest") === "document" && (request.headers.get("upgrade") || "").toLowerCase() !== "websocket") return Response.redirect(new URL("/", url), 302);
  if (PANEL && segs[0] === PANEL && segs[1] === "api") {
    if (!/^(GET|HEAD|OPTIONS)$/.test(request.method) && request.headers.get("origin") !== "https://panel.example.com") return Response.json({ ok: false, msg: "forbidden (origin)" }, { status: 403, headers: SECH });
  }
  if (env.CFK && authed) {
    try {
      const raw = await env.CFK.get("config", { cacheTtl: 60 });
      const admin = raw && JSON.parse(raw).admin;
      if (admin) {
        const r = new Request(request);
        const ck = (request.headers.get("cookie") || "").split(/;\s*/).filter((x) => x && !/^luma_auth=/.test(x));
        ck.push("luma_auth=" + md5hex(String(admin)));
        r.headers.set("cookie", ck.join("; "));
        return secCF(await env.CFNEXT.fetch(r), request);
      }
    } catch (e) {
    }
  }
  const ck0 = request.headers.get("cookie");
  if (ck0 && /(?:^|;\s*)luma_auth=/.test(ck0)) {
    const r = new Request(request);
    const rest = ck0.split(/;\s*/).filter((x) => x && !/^luma_auth=/.test(x));
    if (rest.length) r.headers.set("cookie", rest.join("; "));
    else r.headers.delete("cookie");
    return secCF(await env.CFNEXT.fetch(r), request);
  }
  return secCF(await env.CFNEXT.fetch(request), request);
}
// 2026-10-10: pages served with Referrer-Policy no-referrer make browsers send "Origin: null" on form POSTs
// (Fetch spec), and some clients send no Origin / no Sec-Fetch-Site at all. Classify instead of hard-failing:
//  "bad"     = provably cross-site (foreign Origin or Sec-Fetch-Site != same-origin) -> always reject
//  "ok"      = provably same-origin (Origin matches or Sec-Fetch-Site: same-origin)
//  "unknown" = Origin missing/"null" and no Sec-Fetch-Site -> caller must rely on its per-session CSRF token
function originState(request) {
  const o = request.headers.get("origin"), sfs = request.headers.get("sec-fetch-site");
  if (o && o !== "null" && o !== "https://panel.example.com") return "bad";
  if (sfs && sfs !== "same-origin") return "bad";
  if (o === "https://panel.example.com" || sfs === "same-origin") return "ok";
  return "unknown";
}
function sameOrigin(request) {
  return originState(request) === "ok";
}
async function csrfLogout(env, request) {
  return hmacHex(env.SESSION_SECRET, "csrf-logout:" + gateVal(request));
}
function safeNext(v) {
  v = String(v || "");
  if (!/^\/(?![\/\\])[^\s\\]*$/.test(v) || v.length > 300) return "/";
  try {
    const u = new URL(v, "https://panel.example.com");
    if (u.origin !== "https://panel.example.com") return "/";
    return u.pathname + u.search;
  } catch (e) {
    return "/";
  }
}
function toLogin(url, next) {
  const n = safeNext(next || url.pathname + url.search);
  return Response.redirect(new URL(n === "/" ? "/" : "/?next=" + encodeURIComponent(n), url), 302);
}
var CF_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src * data: blob:; object-src 'none'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'";
function secCF(res, request) {
  try {
    if (!res || res.status === 101 || res.webSocket) return res;
    if ((request.headers.get("upgrade") || "").toLowerCase() === "websocket") return res;
    const ct = res.headers.get("content-type") || "";
    const html = /text\/html/i.test(ct);
    if (!html && !/json/i.test(ct)) return res;
    const out = new Response(res.body, res);
    const h = out.headers;
    const add = (k, v) => {
      if (!h.has(k)) h.set(k, v);
    };
    add("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
    add("X-Content-Type-Options", "nosniff");
    add("X-Frame-Options", "SAMEORIGIN");
    add("Referrer-Policy", "strict-origin-when-cross-origin");
    if (html) add("Content-Security-Policy", CF_CSP);
    return out;
  } catch (e) {
    return res;
  }
}
async function ctEq(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(String(a))), crypto.subtle.digest("SHA-256", enc.encode(String(b)))]);
  if (crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(x, y);
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let d = 0;
  for (let i = 0; i < u.length; i++) d |= u[i] ^ v[i];
  return d === 0;
}
var BOT_RE = /(bot|crawl|spider|scan|curl|wget|python-requests|libwww|nikto|sqlmap|nmap|masscan|httpx|zgrab|go-http)/i;
var PROBE_RE = /(wp-login|wp-admin|xmlrpc|\.env|\.git|phpmyadmin|\/vendor\/|\/cgi-bin|boaform|eval-stdin|\/\.aws|\/\.ssh|\/config\.|\/shell|\/solr|\/actuator|\/console)/i;
var UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
function maskPath(p) {
  return String(p || "").replace(UUID_RE, (m) => m.slice(0, 8) + "\u2026");
}
async function logSec(request, env, url, status, authFail) {
  try {
    if (!env.DB) return;
    const path = url.pathname;
    const PANEL = await panelPath(env);
    if (PANEL && (path === "/" + PANEL || path.startsWith("/" + PANEL + "/"))) return;
    if ((request.headers.get("upgrade") || "").toLowerCase() === "websocket") return;
    const isProbe = PROBE_RE.test(path);
    if (!authFail && status < 400 && !(isProbe && status !== 101)) return;
    const ua = request.headers.get("user-agent") || "";
    const ip = request.headers.get("cf-connecting-ip") || "";
    const co = request.cf && request.cf.country || "";
    const type = authFail ? "auth" : isProbe ? "probe" : BOT_RE.test(ua) ? "bot" : "error";
    const now = Date.now();
    const lp = path.startsWith("/g/") ? "/g/…(访客链接)" : maskPath(path);
    await env.DB.prepare("INSERT INTO events (t, type, ip, co, path, st, ua) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)").bind(now, type, ip, co, lp.slice(0, 300), status, ua.slice(0, 120)).run();
    if (Math.random() < 0.01) await env.DB.prepare("DELETE FROM events WHERE t < ?1").bind(now - 30 * 864e5).run();
  } catch (e) {
  }
}
var PC = null;
async function panelPath(env) {
  const now = Date.now();
  if (PC && now - PC.t < 3e4) return PC.v;
  let v = "";
  try {
    const raw = env.CFK ? await env.CFK.get("config", { cacheTtl: 60 }) : null;
    const c = raw ? JSON.parse(raw) : null;
    v = c ? String(c.path || c.uuid || "") : "";
  } catch (e) {
  }
  if (!/^[0-9A-Za-z-]{8,64}$/.test(v)) v = env.PANEL || "";
  PC = { v, t: now };
  return v;
}
var SV = null;
async function sessVer(env) {
  const now = Date.now();
  if (SV && now - SV.t < 5e3) return SV.v;
  let v = 0;
  try {
    const r = env.DB ? await env.DB.prepare("SELECT ver FROM sess_meta WHERE id = 1").first() : null;
    v = r ? Number(r.ver) || 0 : 0;
  } catch (e) {
    if (SV) return SV.v;
  }
  SV = { v, t: now };
  return v;
}
async function sign(env, exp, ver) {
  return hmacHex(env.SESSION_SECRET, ver ? exp + ":v" + ver : String(exp));
}
async function hmacHex(k, msg) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(k), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function loggedIn(request, env) {
  const m = /(?:^|;\s*)gate=(\d+)\.([0-9a-f]+)/.exec(request.headers.get("cookie") || "");
  if (!m) return false;
  const exp = Number(m[1]);
  if (!exp || exp < Date.now()) return false;
  return await ctEq(m[2], await sign(env, exp, await sessVer(env)));
}
function ipKey(ip) {
  ip = String(ip || "0").toLowerCase();
  if (!ip.includes(":")) return ip;
  let [h, t] = ip.split("::");
  const hp = h ? h.split(":") : [], tp = t !== void 0 ? t ? t.split(":") : [] : [];
  const all = t === void 0 ? hp : [...hp, ...new Array(Math.max(0, 8 - hp.length - tp.length)).fill("0"), ...tp];
  return all.slice(0, 4).map((x) => (x || "0").replace(/^0+(?=.)/, "")).join(":") + "::/64";
}
var FAIL_WINDOW = 15 * 6e4;
var FAIL_LOCK = 8;
async function failCount(env, k, now) {
  try {
    const r = await env.DB.prepare("SELECT n, first FROM login_fail WHERE k = ?1").bind(k).first();
    if (!r || now - Number(r.first) > FAIL_WINDOW) return 0;
    return Number(r.n) || 0;
  } catch (e) {
    return 0;
  }
}
async function failAdd(env, k, now) {
  try {
    const r = await env.DB.prepare("INSERT INTO login_fail (k, n, first, last) VALUES (?1, 1, ?2, ?2) ON CONFLICT(k) DO UPDATE SET n = CASE WHEN ?2 - first > ?3 THEN 1 ELSE n + 1 END, first = CASE WHEN ?2 - first > ?3 THEN ?2 ELSE first END, last = ?2 RETURNING n").bind(k, now, FAIL_WINDOW).first();
    if (Math.random() < 0.05) await env.DB.prepare("DELETE FROM login_fail WHERE last < ?1").bind(now - 864e5).run();
    return r ? Number(r.n) : 1;
  } catch (e) {
    return 1;
  }
}
async function adminLog(env, request, type) {
  if (!env.DB) return;
  await env.DB.prepare("INSERT INTO admin_log (t, type, ip, co, ua) VALUES (?1, ?2, ?3, ?4, ?5)").bind(Date.now(), type, request.headers.get("cf-connecting-ip") || "", request.cf && request.cf.country || "", (request.headers.get("user-agent") || "").slice(0, 120)).run();
}
function devKey(ua) {
  ua = String(ua || "");
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "\u5176\u4ED6";
  const br = /Edg\//.test(ua) ? "Edge" : /CriOS|Chrome\//.test(ua) ? "Chrome" : /FxiOS|Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "\u5176\u4ED6";
  return os + " \xB7 " + br;
}
async function onLoginOk(env, ctx, request, mfa) {
  const now = Date.now(), ip = request.headers.get("cf-connecting-ip") || "", ua = request.headers.get("user-agent") || "";
  const ik = ipKey(ip), dk = devKey(ua);
  let newIp = false, newDev = false;
  try {
    const [a, b] = await env.DB.batch([
      env.DB.prepare("INSERT INTO seen_login (kind, v, first, last) VALUES ('ip', ?1, ?2, ?2) ON CONFLICT(kind, v) DO UPDATE SET last = ?2 RETURNING first").bind(ik, now),
      env.DB.prepare("INSERT INTO seen_login (kind, v, first, last) VALUES ('dev', ?1, ?2, ?2) ON CONFLICT(kind, v) DO UPDATE SET last = ?2 RETURNING first").bind(dk, now)
    ]);
    newIp = Number(((a.results || [])[0] || {}).first) === now;
    newDev = Number(((b.results || [])[0] || {}).first) === now;
  } catch (e) {
  }
  try {
    await adminLog(env, request, "login");
  } catch (e) {
    console.log("admin_log insert failed: " + String(e && e.message || e));
  }
  try {
    await env.DB.prepare("DELETE FROM login_fail WHERE k = ?1").bind(ik).run();
  } catch (e) {
  }
  if (newIp || newDev || mfa === "recovery") await sendLoginMail(env, request, "ok", { newIp, newDev, dev: dk, mfa: mfa || "none", rcLeft: mfa === "recovery" ? await rcLeft(env) : null });
}
async function onLoginFail(env, request, n) {
  if (n !== 3 && n !== FAIL_LOCK) return;
  const now = Date.now();
  let can = false;
  try {
    const r = await env.DB.prepare("INSERT INTO alert_gate (k, t, suppressed) VALUES ('login_fail', ?1, 0) ON CONFLICT(k) DO UPDATE SET t = CASE WHEN ?1 - t >= 3600000 THEN ?1 ELSE t END, suppressed = CASE WHEN ?1 - t >= 3600000 THEN 0 ELSE suppressed + 1 END RETURNING t").bind(now).first();
    can = r && Number(r.t) === now;
  } catch (e) {
    can = false;
  }
  if (!can) return;
  let sum = { n: 0, ips: 0, locked: 0 };
  try {
    sum = await env.DB.prepare("SELECT COALESCE(SUM(n),0) AS n, COUNT(*) AS ips, COALESCE(SUM(n >= ?2),0) AS locked FROM login_fail WHERE last >= ?1").bind(now - 36e5, FAIL_LOCK).first() || sum;
  } catch (e) {
  }
  await sendLoginMail(env, request, n >= FAIL_LOCK ? "lock" : "warn", { n, sum });
}
async function portal(request, env, ctx, url) {
  const nextP = safeNext(url.searchParams.get("next") || "/");
  if (request.method === "POST") {
    if (originState(request) === "bad") return page("\u8BF7\u6C42\u6765\u6E90\u4E0D\u5BF9\uFF0C\u8BF7\u5237\u65B0\u9875\u9762\u91CD\u8BD5", true, 403, nextP);
    const ip = request.headers.get("cf-connecting-ip") || "0", k = ipKey(ip), now = Date.now();
    const rl = env.DB ? await failCount(env, k, now) : 0;
    if (rl >= FAIL_LOCK) return page("\u5C1D\u8BD5\u8FC7\u4E8E\u9891\u7E41,\u8BF7 15 \u5206\u949F\u540E\u518D\u8BD5", true, 429, nextP);
    const form = await request.formData();
    const pw = form.get("password");
    const target = safeNext(form.get("next") || nextP);
    if (env.PASSWORD && typeof pw === "string" && await ctEq(pw, env.PASSWORD)) {
      if (env.TOTP_KEY && await tfaEnabled(env)) {
        const h = new Headers(Object.assign({ "location": "/2fa" + (target !== "/" ? "?next=" + encodeURIComponent(target) : ""), "cache-control": "no-store" }, SECH));
        h.append("set-cookie", `pre2=${await preMake(env)}; HttpOnly; Secure; SameSite=Strict; Path=/2fa; Max-Age=300`);
        return new Response(null, { status: 303, headers: h });
      }
      const exp = Date.now() + 7 * 24 * 3600 * 1e3;
      const cookie = `gate=${exp}.${await sign(env, exp, await sessVer(env))}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`;
      if (env.DB && ctx && ctx.waitUntil) ctx.waitUntil(onLoginOk(env, ctx, request, "none").catch((e) => console.log("login bookkeeping failed: " + String(e && e.message || e))));
      return new Response(null, { status: 303, headers: Object.assign({ "set-cookie": cookie, "location": target, "cache-control": "no-store" }, SECH) });
    }
    const n = env.DB ? await failAdd(env, k, now) : 1;
    if (env.DB && ctx && ctx.waitUntil) ctx.waitUntil(onLoginFail(env, request, n).catch(() => {
    }));
    return page(n >= FAIL_LOCK ? "\u5C1D\u8BD5\u8FC7\u4E8E\u9891\u7E41,\u8BF7 15 \u5206\u949F\u540E\u518D\u8BD5" : "\u5BC6\u7801\u4E0D\u5BF9", true, n >= FAIL_LOCK ? 429 : 200, target);
  }
  if (!await loggedIn(request, env)) {
    const bye = url.searchParams.get("bye");
    return page(bye === "all" ? "\u5DF2\u8BA9\u6240\u6709\u8BBE\u5907\u4E0B\u7EBF\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55" : bye ? "\u5DF2\u9000\u51FA\u767B\u5F55" : url.searchParams.get("e") === "2fa" ? "\u52A8\u6001\u7801\u9519\u8BEF\u6B21\u6570\u592A\u591A\uFF0C\u8BF7\u91CD\u65B0\u8F93\u5165\u5BC6\u7801" : "", false, 200, nextP);
  }
  if (nextP !== "/") return Response.redirect(new URL(nextP, url), 302);
  let head = "\u5168\u90E8\u5728\u7EBF";
  try {
    const rows = env.DB ? (await env.DB.prepare("SELECT svc, up, t FROM health").all()).results || [] : [];
    const NM = { cfnext: "\u4EE3\u7406\u9762\u677F", drive: "\u7F51\u76D8", otp: "\u9A8C\u8BC1\u7801" };
    const down = rows.filter((r) => !r.up).map((r) => NM[r.svc] || r.svc);
    const last = Math.max(0, ...rows.map((r) => Number(r.t) || 0));
    if (!rows.length) head = "\u72B6\u6001\u672A\u77E5";
    else if (down.length) head = down.length + " \u9879\u79BB\u7EBF\uFF1A" + down.join("\u3001");
    else if (Date.now() - last > 20 * 6e4) head = "\u5DE1\u68C0\u8D85\u8FC7 20 \u5206\u949F\u672A\u66F4\u65B0";
  } catch (e) {
    head = "\u72B6\u6001\u672A\u77E5";
  }
  const cls = head === "\u5168\u90E8\u5728\u7EBF" ? "ok" : "bad";
  const tfaOn = await tfaEnabled(env);
  const tfa = tfaOn ? `<p class="tfa-on"><a href="/2fa/setup">\u{1F512} \u4E24\u6B65\u9A8C\u8BC1\u5DF2\u5F00\u542F \xB7 \u7BA1\u7406</a></p>` : `<a class="card tfa-off" href="/2fa/setup"><b>\u26A0 \u672A\u5F00\u542F\u4E24\u6B65\u9A8C\u8BC1\uFF0C\u70B9\u6B64\u7ED1\u5B9A</b><small>\u73B0\u5728\u53EA\u9760\u4E00\u4E2A\u5BC6\u7801\u767B\u5F55\u3002\u7ED1\u5B9A\u624B\u673A\u9A8C\u8BC1\u5668\u540E\uFF0C\u5C31\u7B97\u5BC6\u7801\u6CC4\u9732\u522B\u4EBA\u4E5F\u8FDB\u4E0D\u6765\uFF08\u7EA6 2 \u5206\u949F\uFF09\u3002</small></a>`;
  return new Response(HOME.replaceAll("__LOTOK__", escH(await csrfLogout(env, request))).replaceAll("__PANEL__", escH(await panelPath(env))).replace("__TFA__", tfa).replace("__HEAD__", `<a class="st ${cls}" href="/status">${escH(head)}</a>`), { headers: Object.assign({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }, SECH) });
}
function escH(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
var SECH = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'"
};
function page(err, authFail, status, next) {
  const h = Object.assign({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }, SECH);
  if (authFail) h["x-af"] = "1";
  return new Response(LOGIN.replace("__ERR__", escH(err || "")).replace("__NEXT__", escH(safeNext(next || "/"))), { status: status || 200, headers: h });
}
var CSS = `
:root {
  --bg: #09090b;
  --bg-elevated: #18181b;
  --card: #18181b;
  --card-hover: #27272a;
  --line: #27272a;
  --line-strong: #3f3f46;
  --txt: #fafafa;
  --muted: #a1a1aa;
  --brand: #8b5cf6;
  --brand-hover: #a78bfa;
  --ok: #22c55e;
  --warn: #eab308;
  --err: #ef4444;
  --radius: 12px;
  --shadow: 0 4px 12px rgb(0 0 0 / 0.25);
  --shadow-hover: 0 8px 24px rgb(0 0 0 / 0.35);
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  color: var(--txt);
  background: var(--bg);
  background-image: radial-gradient(ellipse 120% 80% at 50% -20%, rgba(139,92,246,0.1), transparent 45%);
}
a { color: inherit; text-decoration: none; }
main { max-width: 1040px; margin: 0 auto; padding: 32px 20px 80px; }

.mark {
  letter-spacing: 0.1em;
  text-transform: uppercase;
  font-size: 11px;
  font-weight: 600;
  color: var(--muted);
  margin: 0;
}
h1 { 
  font-weight: 650; 
  font-size: 32px; 
  letter-spacing: -0.025em; 
  margin: 8px 0 24px; 
  line-height: 1.15;
  color: var(--txt);
}

.card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.card:hover { border-color: var(--line-strong); box-shadow: var(--shadow-hover); }

.grid { 
  display: grid; 
  gap: 16px; 
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
}
@media (min-width: 720px) { .grid { grid-template-columns: repeat(3, 1fr); } }

.item {
  display: flex;
  flex-direction: column;
  padding: 22px;
  position: relative;
  overflow: hidden;
}
.item::before {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, rgba(139,92,246,0.08), transparent 60%);
  opacity: 0;
  transition: opacity 0.2s;
}
.item:hover::before { opacity: 1; }
.item:hover { transform: translateY(-3px); }
.item .ic {
  width: 40px; height: 40px;
  border-radius: 10px;
  background: rgba(139,92,246,0.12);
  border: 1px solid rgba(139,92,246,0.25);
  display: grid; place-items: center;
  margin-bottom: 14px;
  transition: transform 0.2s, background 0.2s;
}
.item:hover .ic { transform: scale(1.05); background: rgba(139,92,246,0.18); }
.item .ic svg { width: 20px; height: 20px; stroke: var(--brand); fill: none; stroke-width: 2; }
.item strong { font-size: 16px; font-weight: 600; display: block; margin-bottom: 4px; }
.item small { display: block; color: var(--muted); font-size: 13px; line-height: 1.5; }

input, button { font: inherit; }
input {
  width: 100%;
  border: 1px solid var(--line);
  background: var(--bg);
  color: var(--txt);
  border-radius: 8px;
  padding: 12px 14px;
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
  font-size: 15px;
}
input:focus { border-color: var(--brand); box-shadow: 0 0 0 3px rgba(139,92,246,0.3); }
button {
  border: 0;
  background: var(--brand);
  color: #fff;
  border-radius: 8px;
  padding: 12px 16px;
  width: 100%;
  margin-top: 12px;
  font-weight: 500;
  font-size: 15px;
  cursor: pointer;
  transition: background 0.15s, transform 0.1s;
}
button:hover { background: var(--brand-hover); }
button:active { transform: scale(0.98); }

.otp {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 16px; margin: 0 0 20px;
  border-color: rgba(139,92,246,0.35);
  background: rgba(139,92,246,0.08);
  animation: fadeIn 0.3s ease;
}
@keyframes fadeIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
.otp[hidden] { display: none; }
.otp .mark { flex: none; margin: 0; }
.otp .oc { font-size: 22px; font-weight: 700; letter-spacing: 0.1em; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--txt); flex: none; }
.otp small { color: var(--muted); min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.otp button { width: auto; margin: 0; padding: 6px 12px; flex: none; font-size: 12px; }
.otp .ox { background: transparent; border: 0; color: var(--muted); padding: 4px 8px; font-size: 18px; line-height: 1; box-shadow: none; border-radius: 6px; }
.otp .ox:hover { background: rgba(255,255,255,0.06); color: var(--txt); }

.hd { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 8px; }
.acts { display: flex; gap: 8px; }
.acts form { margin: 0; }
button.lo { 
  width: auto; margin: 0; padding: 7px 12px; 
  font-size: 13px; font-weight: 500; 
  background: transparent; 
  border: 1px solid var(--line); 
  box-shadow: none; color: var(--muted); 
  border-radius: 8px;
}
button.lo:hover { background: var(--card-hover); color: var(--txt); border-color: var(--line-strong); }
button.lo.warn { color: #fca5a5; border-color: rgba(239,68,68,0.4); }
button.lo.warn:hover { background: rgba(239,68,68,0.1); }

.tfa-off { 
  display: block; text-decoration: none; 
  padding: 16px 20px; margin: 0 0 20px; 
  border-color: rgba(234,179,8,0.4); 
  background: rgba(234,179,8,0.08); 
  border-radius: var(--radius);
  transition: border-color 0.15s;
}
.tfa-off b { font-size: 16px; color: #fde68a; }
.tfa-off small { display: block; color: var(--muted); margin-top: 4px; }
.tfa-off:hover { border-color: #eab308; }
.tfa-on { margin: -10px 0 20px; font-size: 13px; }
.tfa-on a { color: var(--ok); text-decoration: none; }

.st { text-decoration: none; letter-spacing: 0.04em; font-weight: 500; }
.st.ok { color: var(--ok); }
.st.bad { color: #fca5a5; font-weight: 600; }
`;;;
var LOGIN = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录</title><style>${CSS}</style><main style="max-width:380px;padding-top:20vh"><p class="mark">panel.example.com</p><div class="card" style="padding:28px"><h1 style="font-size:26px;margin:0 0 6px">进入工作台</h1><p style="color:var(--muted);margin:0 0 20px;font-size:14px">代理、验证码和网盘都在登录后。</p><form method="post" action="/"><input type="hidden" name="next" value="__NEXT__"><input name="password" type="password" placeholder="密码" autocomplete="current-password" autofocus><button type="submit">继续</button></form><p style="color:var(--err);min-height:1.4em;margin:10px 0 0;font-size:13px">__ERR__</p></div></main>`;
var HOME = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>工作台</title><style>${CSS}</style><main><div class="hd"><p class="mark">工作台 · __HEAD__</p><div class="acts"><form method="post" action="/logout"><input type="hidden" name="csrf" value="__LOTOK__"><button class="lo" type="submit">退出登录</button></form><form method="post" action="/logout?all=1" onsubmit="return confirm('让所有已登录的设备（包括这台）都下线？\n之后需要重新输入密码登录。')"><input type="hidden" name="csrf" value="__LOTOK__"><button class="lo warn" type="submit">下线所有设备</button></form></div></div><h1>panel.example.com</h1>__TFA__<div id="otp" class="card otp" hidden><span class="mark">最新验证码</span><span class="oc" id="otpc">——</span><button id="otpb" type="button">复制</button><small id="otpm"></small><button id="otpx" class="ox" type="button" title="关闭这个验证码" aria-label="关闭">×</button></div><div class="grid"><a class="card item" href="/__PANEL__"><span class="ic"><svg viewBox="0 0 24 24"><path d="M4 7l8-4 8 4v6c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V7z"/></svg></span><strong>代理面板</strong><small>订阅、节点和出站设置。</small></a><a class="card item" href="/mail"><span class="ic"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg></span><strong>验证码</strong><small>读取 Outlook 邮件里的验证码。</small></a><a class="card item" href="/drive"><span class="ic"><svg viewBox="0 0 24 24"><path d="M3 7h6l2 2h10v8a2 2 0 0 1-2 2H3z"/></svg></span><strong>网盘</strong><small>小文件放在私有 GitHub 仓库。</small></a><a class="card item" href="/status"><span class="ic"><svg viewBox="0 0 24 24"><path d="M12 3l8 4v5c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V7z"/><path d="M9 12l2 2 4-4"/></svg></span><strong>安全监控</strong><small>攻击、爬虫与异常访问。</small></a><a class="card item" href="/admin/tokens"><span class="ic"><svg viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/></svg></span><strong>令牌 / 密钥</strong><small>所有 API 令牌、Worker 密钥名称和风险提示。</small></a><a class="card item" href="/admin/audit"><span class="ic"><svg viewBox="0 0 24 24"><path d="M6 3h9l4 4v14H6z"/><path d="M9 11h7M9 15h7M9 7h4"/></svg></span><strong>审计日志</strong><small>谁在什么时候改了 DNS、隧道、规则，和工作台登录记录。</small></a><a class="card item" href="/admin/config-history"><span class="ic"><svg viewBox="0 0 24 24"><path d="M12 3v18M8 7h8M8 12h8M8 17h5"/></svg></span><strong>配置版本</strong><small>CFNext 配置的加密历史，一键回滚。</small></a><a class="card item" href="/admin/proxy"><span class="ic"><svg viewBox="0 0 24 24"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg></span><strong>代理节点仪表盘</strong><small>订阅拉取、代理流量、来源 IP 和节点健康。</small></a><a class="card item" href="/admin/guests"><span class="ic"><svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><path d="M16 4.5a3.3 3.3 0 0 1 0 6.5M18 14.5c2 .6 3.2 2.4 3.5 5"/></svg></span><strong>访客</strong><small>给家人朋友一个只读订阅链接，随时撤销。</small></a></div></main><script>
(function(){var box=document.getElementById("otp"),c=document.getElementById("otpc"),m=document.getElementById("otpm"),b=document.getElementById("otpb"),x=document.getElementById("otpx"),cur=null,MAX=600000;
function key(o){return "otpx:"+(o.id||"")+":"+o.code;}
function gone(o){try{return localStorage.getItem(key(o))!==null;}catch(e){return false;}}
function ago(ms){var s=Math.max(0,Math.floor(ms/1000));return s<60?s+" 秒前":Math.floor(s/60)+" 分钟前";}
function draw(){if(!cur||gone(cur)){box.hidden=true;return;}var age=Date.now()-cur.at;if(age>MAX){box.hidden=true;cur=null;return;}box.hidden=false;c.textContent=cur.code;m.textContent=ago(age)+" · "+(cur.from||"")+(cur.subject?" · "+cur.subject:"");m.title=m.textContent;}
async function poll(){if(document.hidden)return;try{var r=await fetch("/api/otp-latest",{cache:"no-store",credentials:"same-origin"});if(!r.ok)return;var d=await r.json();cur=(d&&d.code&&d.fresh)?{id:String(d.id||""),code:String(d.code),from:d.from,subject:d.subject,at:Date.now()-Number(d.age_ms||0)}:null;draw();}catch(e){}}
function done(){b.textContent="已复制";setTimeout(function(){b.textContent="复制";},1500);}
b.onclick=function(){if(!cur)return;if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(cur.code).then(done,function(){fb();});}else fb();};
x.onclick=function(){if(!cur)return;try{var now=Date.now();for(var i=localStorage.length-1;i>=0;i--){var k=localStorage.key(i);if(k&&k.indexOf("otpx:")===0&&now-Number(localStorage.getItem(k)||0)>86400000)localStorage.removeItem(k);}localStorage.setItem(key(cur),String(now));}catch(e){}box.hidden=true;};
function fb(){var t=document.createElement("textarea");t.value=cur.code;document.body.appendChild(t);t.select();try{document.execCommand("copy");done();}catch(e){}t.remove();}
poll();setInterval(poll,20000);setInterval(draw,1000);document.addEventListener("visibilitychange",function(){if(!document.hidden)poll();});})();
</script>`;;
var TE = new TextEncoder();
var MD5_S = [
  7,
  12,
  17,
  22,
  7,
  12,
  17,
  22,
  7,
  12,
  17,
  22,
  7,
  12,
  17,
  22,
  5,
  9,
  14,
  20,
  5,
  9,
  14,
  20,
  5,
  9,
  14,
  20,
  5,
  9,
  14,
  20,
  4,
  11,
  16,
  23,
  4,
  11,
  16,
  23,
  4,
  11,
  16,
  23,
  4,
  11,
  16,
  23,
  6,
  10,
  15,
  21,
  6,
  10,
  15,
  21,
  6,
  10,
  15,
  21,
  6,
  10,
  15,
  21
];
var MD5_K = [
  3614090360,
  3905402710,
  606105819,
  3250441966,
  4118548399,
  1200080426,
  2821735955,
  4249261313,
  1770035416,
  2336552879,
  4294925233,
  2304563134,
  1804603682,
  4254626195,
  2792965006,
  1236535329,
  4129170786,
  3225465664,
  643717713,
  3921069994,
  3593408605,
  38016083,
  3634488961,
  3889429448,
  568446438,
  3275163606,
  4107603335,
  1163531501,
  2850285829,
  4243563512,
  1735328473,
  2368359562,
  4294588738,
  2272392833,
  1839030562,
  4259657740,
  2763975236,
  1272893353,
  4139469664,
  3200236656,
  681279174,
  3936430074,
  3572445317,
  76029189,
  3654602809,
  3873151461,
  530742520,
  3299628645,
  4096336452,
  1126891415,
  2878612391,
  4237533241,
  1700485571,
  2399980690,
  4293915773,
  2240044497,
  1873313359,
  4264355552,
  2734768916,
  1309151649,
  4149444226,
  3174756917,
  718787259,
  3951481745
];
function rotl32(x, c) {
  return (x << c | x >>> 32 - c) >>> 0;
}
function md5hex(str) {
  const bytes = TE.encode(String(str));
  const bitLen = bytes.length * 8;
  const paddedLen = (bytes.length + 8 >> 6) + 1 << 6;
  const data = new Uint8Array(paddedLen);
  data.set(bytes);
  data[bytes.length] = 128;
  const dv = new DataView(data.buffer);
  dv.setUint32(paddedLen - 8, bitLen >>> 0, true);
  dv.setUint32(paddedLen - 4, Math.floor(bitLen / 4294967296), true);
  let a0 = 1732584193, b0 = 4023233417, c0 = 2562383102, d0 = 271733878;
  for (let i = 0; i < paddedLen; i += 64) {
    const M = new Uint32Array(16);
    for (let j = 0; j < 16; j++) M[j] = dv.getUint32(i + j * 4, true);
    let a = a0, b = b0, c = c0, d = d0;
    for (let j = 0; j < 64; j++) {
      let f, g;
      if (j < 16) {
        f = b & c | ~b & d;
        g = j;
      } else if (j < 32) {
        f = d & b | ~d & c;
        g = (5 * j + 1) % 16;
      } else if (j < 48) {
        f = b ^ c ^ d;
        g = (3 * j + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = 7 * j % 16;
      }
      const sum = a + f + MD5_K[j] + M[g] >>> 0;
      const nb = b + rotl32(sum, MD5_S[j]) >>> 0;
      a = d;
      d = c;
      c = b;
      b = nb;
    }
    a0 = a0 + a >>> 0;
    b0 = b0 + b >>> 0;
    c0 = c0 + c >>> 0;
    d0 = d0 + d >>> 0;
  }
  let hex = "";
  for (const v of [a0, b0, c0, d0]) {
    hex += (v & 255).toString(16).padStart(2, "0");
    hex += (v >>> 8 & 255).toString(16).padStart(2, "0");
    hex += (v >>> 16 & 255).toString(16).padStart(2, "0");
    hex += (v >>> 24 & 255).toString(16).padStart(2, "0");
  }
  return hex;
}
var LA_FROM = "alert@panel.example.com";
var LA_TO = "<OWNER_EMAIL>";
function laB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 32768) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
  return btoa(bin);
}
function laFmt(ts) {
  return new Date(ts + 8 * 36e5).toISOString().replace("T", " ").slice(0, 19) + " (UTC+8)";
}
function buildLoginMime(kind, info, request, now) {
  info = info || {};
  const subject = kind === "ok" ? info.mfa === "recovery" ? "[\u9762\u677F] \u7528\u6062\u590D\u7801\u767B\u5F55\u4E86\u5DE5\u4F5C\u53F0" : "[\u9762\u677F] \u65B0\u8BBE\u5907 / \u65B0 IP \u767B\u5F55" : kind === "lock" ? "[\u9762\u677F] \u6709 IP \u56E0\u5BC6\u7801\u9519\u8BEF\u88AB\u9501\u5B9A" : "[\u9762\u677F] \u591A\u6B21\u5BC6\u7801\u9519\u8BEF";
  const cf = request.cf || {};
  const head = kind === "ok" ? "\u5DE5\u4F5C\u53F0 panel.example.com \u521A\u521A\u4ECE" + (info.newIp && info.newDev ? "\u65B0\u7684 IP \u548C\u65B0\u7684\u8BBE\u5907" : info.newIp ? "\u65B0\u7684 IP" : info.newDev ? "\u65B0\u7684\u8BBE\u5907" : "\u5E38\u7528\u8BBE\u5907") + "\u767B\u5F55\u6210\u529F" + (info.mfa === "recovery" ? "\uFF0C\u7528\u7684\u662F\u4E00\u6B21\u6027\u6062\u590D\u7801\u3002" : "\uFF08\u5E38\u7528 IP / \u8BBE\u5907\u767B\u5F55\u4E0D\u518D\u53D1\u90AE\u4EF6\uFF09\u3002") : kind === "lock" ? "\u540C\u4E00 IP \u5DF2\u8FDE\u7EED\u8F93\u9519\u5BC6\u7801 " + info.n + " \u6B21,\u5DF2\u88AB\u9501\u5B9A 15 \u5206\u949F\u3002" : "\u540C\u4E00 IP \u5DF2\u8FDE\u7EED\u8F93\u9519\u5BC6\u7801 " + info.n + " \u6B21\u3002";
  const lines = [
    head,
    "",
    "\u65F6\u95F4:" + laFmt(now),
    "IP:" + (request.headers.get("cf-connecting-ip") || "\u672A\u77E5"),
    "\u4F4D\u7F6E:" + [cf.country, cf.city].filter(Boolean).join(" / ") + (cf.asOrganization ? " \xB7 " + cf.asOrganization : ""),
    "\u8BBE\u5907:" + (info.dev ? info.dev + " \xB7 " : "") + (request.headers.get("user-agent") || "\u672A\u77E5")
  ];
  if (kind === "ok") lines.push("\u4E24\u6B65\u9A8C\u8BC1:" + (info.mfa === "totp" ? "\u5DF2\u4F7F\u7528\uFF08\u5BC6\u7801 + \u624B\u673A\u52A8\u6001\u7801\uFF09" : info.mfa === "recovery" ? "\u4F7F\u7528\u4E86\u6062\u590D\u7801\uFF08\u5269\u4F59 " + (info.rcLeft == null ? "?" : info.rcLeft) + " \u4E2A\uFF09" : "\u672A\u4F7F\u7528\uFF08\u8FD8\u6CA1\u5F00\u542F\u4E24\u6B65\u9A8C\u8BC1\uFF0C\u53EA\u7528\u4E86\u5BC6\u7801\uFF09"));
  if (kind !== "ok" && info.sum) lines.push("", "\u6700\u8FD1 1 \u5C0F\u65F6\u5168\u7AD9\uFF1A\u5BC6\u7801\u9519\u8BEF " + info.sum.n + " \u6B21\uFF0C\u6765\u81EA " + info.sum.ips + " \u4E2A IP\uFF08IPv6 \u6309 /64 \u5408\u5E76\uFF09\uFF0C\u5176\u4E2D " + info.sum.locked + " \u4E2A\u5DF2\u88AB\u9501\u5B9A\u3002", "\u8FD9\u7C7B\u544A\u8B66\u6BCF\u5C0F\u65F6\u6700\u591A\u53D1 1 \u5C01\uFF0C\u5176\u4F59\u8BA1\u5165\u6BCF\u65E5\u62A5\u544A\u3002");
  lines.push("", kind === "ok" ? "\u5982\u679C\u4E0D\u662F\u4F60\u672C\u4EBA,\u8BF7\u7ACB\u523B\u5728\u5DE5\u4F5C\u53F0\u70B9\u300C\u4E0B\u7EBF\u6240\u6709\u8BBE\u5907\u300D\u5E76\u4FEE\u6539\u767B\u5F55\u5BC6\u7801\u3002" : "\u5982\u679C\u4E0D\u662F\u4F60\u672C\u4EBA,\u4E00\u822C\u662F\u6709\u4EBA\u5728\u8BD5\u5BC6\u7801,\u9501\u5B9A\u4F1A\u81EA\u52A8\u751F\u6548;\u9891\u7E41\u51FA\u73B0\u8BF7\u8003\u8651\u6362\u4E00\u4E2A\u66F4\u957F\u7684\u5BC6\u7801\u3002");
  const body = laB64(lines.join("\r\n")).replace(/.{1,76}/g, "$&\r\n");
  return { subject, raw: [
    "From: =?UTF-8?B?" + laB64("\u9762\u677F\u76D1\u63A7") + "?= <" + LA_FROM + ">",
    "To: <" + LA_TO + ">",
    "Subject: =?UTF-8?B?" + laB64(subject) + "?=",
    "Date: " + new Date(now).toUTCString().replace("GMT", "+0000"),
    "Message-ID: <" + crypto.randomUUID() + "@panel.example.com>",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    body
  ].join("\r\n") };
}
async function sendLoginMail(env, request, kind, info) {
  if (!env.DB) return;
  try {
    const m = buildLoginMime(kind, info, request, Date.now());
    await outboxMime(env, "login", m.raw);
  } catch (e) {
    console.log("login alert failed: " + String(e && e.message || e));
  }
}
var TFA_ISSUER = "panel.example.com";
var TFA_ACCOUNT = "workbench";
var PRE_TTL = 5 * 6e4;
var PRE_MAX_TRIES = 5;
var MAILCODE_TTL = 20 * 6e4;
var MAILCODE_TRIES = 5;
var MAIL_PER_HOUR = 6;
var te = new TextEncoder();
var B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function b32enc(bytes) {
  let bits = 0, v = 0, out = "";
  for (const b of bytes) {
    v = v << 8 | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[v >>> bits - 5 & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[v << 5 - bits & 31];
  return out;
}
function hexOf(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function b64e(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
  return btoa(s);
}
function b64d(s) {
  const bin = atob(String(s));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
async function hotp(secret, counter) {
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    msg[i] = c & 255;
    c = Math.floor(c / 256);
  }
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const o = h[19] & 15;
  const n = (h[o] & 127) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3];
  return String(n % 1e6).padStart(6, "0");
}
async function totpMatch(secret, code, lastStep, now) {
  code = String(code || "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(code)) return -1;
  const cur = Math.floor(now / 3e4);
  let hit = -1;
  for (const s of [cur - 1, cur, cur + 1]) {
    const ok = await ctEq(await hotp(secret, s), code);
    if (ok && s > (Number(lastStep) || 0) && hit < 0) hit = s;
  }
  return hit;
}
async function tfaKey(env, usage) {
  if (!env.TOTP_KEY) throw new Error("TOTP_KEY missing");
  return crypto.subtle.importKey("raw", b64d(env.TOTP_KEY), { name: "AES-GCM" }, false, [usage]);
}
async function tfaEnc(env, bytes, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode(aad) }, await tfaKey(env, "encrypt"), bytes));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return "v1:" + b64e(out);
}
async function tfaDec(env, s, aad) {
  const m = /^v1:([A-Za-z0-9+/=]+)$/.exec(String(s || ""));
  if (!m) throw new Error("bad ciphertext");
  const buf = b64d(m[1]);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf.slice(0, 12), additionalData: te.encode(aad) }, await tfaKey(env, "decrypt"), buf.slice(12)));
}
async function tfaMac(env, msg) {
  return hmacHex(env.TOTP_KEY, msg);
}
async function tfaRow(env) {
  try {
    return env.DB ? await env.DB.prepare("SELECT secret_enc, enabled, last_step, created_at FROM totp WHERE id = 1").first() : null;
  } catch (e) {
    return null;
  }
}
async function tfaEnabled(env) {
  const r = await tfaRow(env);
  return !!(r && r.enabled && r.secret_enc);
}
function rcNorm(c) {
  return String(c || "").toLowerCase().replace(/[^0-9a-z]/g, "");
}
var RC_ALPHA = "23456789abcdefghjkmnpqrstuvwxyz";
function rcNew() {
  const r = crypto.getRandomValues(new Uint8Array(10));
  let s = "";
  for (const b of r) s += RC_ALPHA[b % RC_ALPHA.length];
  return s.slice(0, 5) + "-" + s.slice(5);
}
async function tfaVerifyFactor(env, input, now) {
  const row = await tfaRow(env);
  if (!row || !row.enabled) return "";
  const v = String(input || "").trim();
  if (/^\d{3}\s?\d{3}$/.test(v)) {
    const secret = await tfaDec(env, row.secret_enc, "totp:secret");
    const step = await totpMatch(secret, v, row.last_step, now);
    if (step < 0) return "";
    const u2 = await env.DB.prepare("UPDATE totp SET last_step = ?1, updated_at = ?2 WHERE id = 1 AND last_step < ?1").bind(step, now).run();
    return u2.meta && u2.meta.changes === 1 ? "totp" : "";
  }
  const n = rcNorm(v);
  if (n.length !== 10) return "";
  const h = await tfaMac(env, "rc:" + n);
  const u = await env.DB.prepare("UPDATE totp_recovery SET used_at = ?2 WHERE h = ?1 AND used_at IS NULL").bind(h, now).run();
  return u.meta && u.meta.changes === 1 ? "recovery" : "";
}
async function rcLeft(env) {
  try {
    const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM totp_recovery WHERE used_at IS NULL").first();
    return r ? Number(r.n) : 0;
  } catch (e) {
    return 0;
  }
}
async function preMake(env) {
  const exp = Date.now() + PRE_TTL, nonce = hexOf(crypto.getRandomValues(new Uint8Array(16))), ver = await sessVer(env);
  return exp + "." + nonce + "." + await hmacHex(env.SESSION_SECRET, "pre2:" + exp + ":" + nonce + ":v" + ver);
}
async function preRead(request, env) {
  const m = /(?:^|;\s*)pre2=(\d+)\.([0-9a-f]{32})\.([0-9a-f]{64})/.exec(request.headers.get("cookie") || "");
  if (!m) return null;
  const exp = Number(m[1]);
  if (!exp || exp < Date.now()) return null;
  if (!await ctEq(m[3], await hmacHex(env.SESSION_SECRET, "pre2:" + exp + ":" + m[2] + ":v" + await sessVer(env)))) return null;
  return { exp, nonce: m[2] };
}
var PRE_CLEAR = "pre2=; HttpOnly; Secure; SameSite=Strict; Path=/2fa; Max-Age=0";
async function gateCookieFor(env) {
  const exp = Date.now() + 7 * 24 * 3600 * 1e3;
  return `gate=${exp}.${await sign(env, exp, await sessVer(env))}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`;
}
function gateVal(request) {
  const m = /(?:^|;\s*)gate=(\d+\.[0-9a-f]+)/.exec(request.headers.get("cookie") || "");
  return m ? m[1] : "";
}
async function sidOf(request) {
  return hexOf(await crypto.subtle.digest("SHA-256", te.encode("sid:" + gateVal(request))));
}
async function csrfTfa(env, request) {
  return hmacHex(env.SESSION_SECRET, "csrf2fa:" + gateVal(request));
}
function qrSvg(text) {
  const q = qrcode_default(0, "M");
  q.addData(text, "Byte");
  q.make();
  const n = q.getModuleCount(), pad = 4, sz = n + pad * 2;
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + pad} ${r + pad}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${sz} ${sz}" width="232" height="232" shape-rendering="crispEdges" role="img" aria-label="\u4E24\u6B65\u9A8C\u8BC1\u4E8C\u7EF4\u7801"><rect width="${sz}" height="${sz}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
function otpauthUri(secretB32) {
  return "otpauth://totp/" + encodeURIComponent(TFA_ISSUER) + ":" + encodeURIComponent(TFA_ACCOUNT) + "?secret=" + secretB32 + "&issuer=" + encodeURIComponent(TFA_ISSUER) + "&algorithm=SHA1&digits=6&period=30";
}
function mimeText(subject, lines) {
  const body = laB64(lines.join("\r\n")).replace(/.{1,76}/g, "$&\r\n");
  return [
    "From: =?UTF-8?B?" + laB64("\u9762\u677F\u76D1\u63A7") + "?= <" + LA_FROM + ">",
    "To: <" + LA_TO + ">",
    "Subject: =?UTF-8?B?" + laB64(subject) + "?=",
    "Date: " + (/* @__PURE__ */ new Date()).toUTCString().replace("GMT", "+0000"),
    "Message-ID: <" + crypto.randomUUID() + "@panel.example.com>",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    body
  ].join("\r\n");
}
async function mailSend(env, subject, lines, kind) {
  if (!env.DB) throw new Error("no DB");
  kind = kind || "notice";
  // a newer 2FA code makes any still-queued older code useless -> never send it
  if (kind === "2fa") { try { await env.DB.prepare("UPDATE mail_outbox SET status = 'superseded', error = 'newer code requested' WHERE kind = '2fa' AND status = 'pending'").run(); } catch (e) {} }
  await outboxPut(env, kind, subject, lines.join("\n"), null);
}
function whoLines(request) {
  const cf = request.cf || {};
  return ["\u65F6\u95F4\uFF1A" + laFmt(Date.now()), "IP\uFF1A" + (request.headers.get("cf-connecting-ip") || "\u672A\u77E5"), "\u4F4D\u7F6E\uFF1A" + [cf.country, cf.city].filter(Boolean).join(" / "), "\u8BBE\u5907\uFF1A" + devKey(request.headers.get("user-agent") || "") + " \xB7 " + String(request.headers.get("user-agent") || "\u672A\u77E5").slice(0, 160)];
}
async function mailQuotaOk(env, now) {
  try {
    const r = await env.DB.prepare("INSERT INTO alert_gate (k, t, suppressed) VALUES ('tfa_mail', ?1, 0) ON CONFLICT(k) DO UPDATE SET t = CASE WHEN ?1 - t >= 3600000 THEN ?1 ELSE t END, suppressed = CASE WHEN ?1 - t >= 3600000 THEN 0 ELSE suppressed + 1 END RETURNING suppressed").bind(now).first();
    return !!r && Number(r.suppressed) < MAIL_PER_HOUR;
  } catch (e) {
    return false;
  }
}
async function tfaFailAdd(env, request, now) {
  return failAdd(env, "2fa:" + ipKey(request.headers.get("cf-connecting-ip") || "0"), now);
}
async function tfaLocked(env, request, now) {
  return await failCount(env, "2fa:" + ipKey(request.headers.get("cf-connecting-ip") || "0"), now) >= FAIL_LOCK;
}
function tfaHtml(title, inner, status, extraHeaders) {
  const h = Object.assign({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }, SECH, extraHeaders || {});
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="same-origin"><title>${escH(title)}</title><style>${CSS}${TFA_CSS}</style><main style="max-width:560px;padding-top:8vh"><p class="mark">panel.example.com \xB7 \u4E24\u6B65\u9A8C\u8BC1</p><div class="card" style="padding:30px">${inner}</div></main>`, { status: status || 200, headers: h });
}
var TFA_CSS = `.tf h1{margin:6px 0 8px;font-weight:620;font-size:26px}.tf p{color:var(--muted);line-height:1.65}.tf .err{color:#ff9d9d;min-height:1.2em}.tf .ok{color:var(--ok)}
.tf input.code{font-size:26px;letter-spacing:.3em;text-align:center;font-family:ui-monospace,Menlo,Consolas,monospace}.tf .qr{background:#fff;border-radius:16px;padding:12px;width:max-content;margin:14px auto;box-shadow:0 18px 40px rgba(0,0,0,.45)}
.tf .sec{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:17px;letter-spacing:.12em;word-break:break-all;background:var(--card2);border:1px dashed rgba(122,92,255,.55);border-radius:12px;padding:12px 14px;color:#fff;text-align:center}
.tf ol{color:var(--muted);line-height:1.8;padding-left:20px}.tf .rc{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:14px 0}.tf .rc code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:17px;background:var(--card2);border:1px solid var(--line);border-radius:10px;padding:8px;text-align:center;color:#fff}
.tf .row{display:flex;gap:10px}.tf .row button{flex:1}.tf button.gh{background:rgba(255,255,255,.06);border:1px solid var(--line);box-shadow:none;color:var(--txt)}.tf button.dg{background:linear-gradient(135deg,#ff6b6b,#b44cff)}
.tf .warn{border-left:3px solid #ffb84d;background:rgba(255,184,77,.07);padding:10px 14px;border-radius:8px;color:#f3d7a6;font-size:14px;line-height:1.6}.tf a{color:#9db8ff}.tf hr{border:0;border-top:1px solid var(--line);margin:24px 0}`;
async function tfaLoginPage(request, env, ctx, url) {
  const pre = await preRead(request, env);
  if (!pre) return Response.redirect(new URL("/", url), 303);
  const now = Date.now();
  const ptok = await hmacHex(env.SESSION_SECRET, "csrf2fa-pre:" + pre.nonce);
  const tfaCodeForm = (e, n, s, af) => tfaCodeForm0(e, n, s, af, ptok);
  if (request.method === "GET") return tfaCodeForm("", safeNext(url.searchParams.get("next") || "/"));
  const ost = originState(request);
  if (ost === "bad") return tfaCodeForm("\u8BF7\u6C42\u6765\u6E90\u4E0D\u5BF9\uFF0C\u8BF7\u5237\u65B0\u9875\u9762\u91CD\u8BD5", "/", 403);
  const form = await request.formData();
  if (ost === "unknown" && !await ctEq(String(form.get("csrf") || ""), ptok)) return tfaCodeForm("\u9875\u9762\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u8F93\u5165\u52A8\u6001\u7801", safeNext(form.get("next") || "/"), 403);
  const target = safeNext(form.get("next") || "/");
  if (await tfaLocked(env, request, now)) return tfaCodeForm("\u5C1D\u8BD5\u8FC7\u4E8E\u9891\u7E41\uFF0C\u8BF7 15 \u5206\u949F\u540E\u518D\u8BD5", target, 429);
  const tries = await failCount(env, "pre:" + pre.nonce, now);
  if (tries >= PRE_MAX_TRIES) return new Response(null, { status: 303, headers: Object.assign({ "location": "/?e=2fa", "set-cookie": PRE_CLEAR, "cache-control": "no-store" }, SECH) });
  let kind = "";
  try {
    kind = await tfaVerifyFactor(env, form.get("code"), now);
  } catch (e) {
    console.log("2fa verify error: " + String(e && e.message || e));
  }
  if (kind) {
    try {
      await env.DB.prepare("INSERT INTO sso_nonce (n, exp) VALUES (?1, ?2)").bind("pre:" + pre.nonce, pre.exp).run();
    } catch (e) {
      return new Response(null, { status: 303, headers: Object.assign({ "location": "/", "set-cookie": PRE_CLEAR }, SECH) });
    }
    const cookie = await gateCookieFor(env);
    try {
      await env.DB.prepare("DELETE FROM login_fail WHERE k = ?1").bind("2fa:" + ipKey(request.headers.get("cf-connecting-ip") || "0")).run();
    } catch (e) {
    }
    if (ctx && ctx.waitUntil) ctx.waitUntil(onLoginOk(env, ctx, request, kind).catch((e) => console.log("login bookkeeping failed: " + String(e && e.message || e))));
    const h = new Headers(Object.assign({ "location": target, "cache-control": "no-store" }, SECH));
    h.append("set-cookie", cookie);
    h.append("set-cookie", PRE_CLEAR);
    return new Response(null, { status: 303, headers: h });
  }
  await failAdd(env, "pre:" + pre.nonce, now);
  const n = await tfaFailAdd(env, request, now);
  if (ctx && ctx.waitUntil) ctx.waitUntil(onLoginFail(env, request, n).catch(() => {
  }));
  const left = PRE_MAX_TRIES - tries - 1;
  return tfaCodeForm(n >= FAIL_LOCK ? "\u5C1D\u8BD5\u8FC7\u4E8E\u9891\u7E41\uFF0C\u8BF7 15 \u5206\u949F\u540E\u518D\u8BD5" : "\u52A8\u6001\u7801\u4E0D\u5BF9\u6216\u5DF2\u7528\u8FC7" + (left > 0 ? `\uFF08\u8FD9\u6B21\u767B\u5F55\u8FD8\u80FD\u8BD5 ${left} \u6B21\uFF09` : "\uFF0C\u8BF7\u91CD\u65B0\u8F93\u5165\u5BC6\u7801"), target, n >= FAIL_LOCK ? 429 : 200, true);
}
function tfaCodeForm0(err, next, status, af, tok) {
  return tfaHtml("\u4E24\u6B65\u9A8C\u8BC1", `<div class="tf"><h1>\u8F93\u5165\u52A8\u6001\u7801</h1><p>\u6253\u5F00\u624B\u673A\u4E0A\u7684\u9A8C\u8BC1\u5668 App\uFF08Google / Microsoft Authenticator\uFF09\uFF0C\u8F93\u5165\u300C${escH(TFA_ISSUER)}\u300D\u663E\u793A\u7684 6 \u4F4D\u6570\u5B57\u3002\u624B\u673A\u4E0D\u5728\u8EAB\u8FB9\u65F6\uFF0C\u53EF\u4EE5\u8F93\u5165\u4E00\u4E2A\u6062\u590D\u7801\uFF08\u5F62\u5982 abcde-fghjk\uFF09\u3002</p>
<form method="post" action="/2fa" autocomplete="off"><input type="hidden" name="csrf" value="${escH(tok || "")}"><input type="hidden" name="next" value="${escH(safeNext(next))}"><input class="code" name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="000000" maxlength="16" autofocus required><button>\u9A8C\u8BC1\u5E76\u8FDB\u5165\u5DE5\u4F5C\u53F0</button></form>
<p class="err">${escH(err || "")}</p><p style="font-size:13px">\u8FD9\u4E00\u6B65 5 \u5206\u949F\u5185\u6709\u6548\uFF0C\u8D85\u65F6\u8BF7\u56DE\u5230 <a href="/">\u767B\u5F55\u9875</a> \u91CD\u65B0\u8F93\u5165\u5BC6\u7801\u3002</p></div>`, status, af ? { "x-af": "1" } : null);
}
async function tfaSetup(request, env, ctx, url) {
  if (!await loggedIn(request, env)) return toLogin(url);
  if (!env.TOTP_KEY || !env.DB) return tfaHtml("\u4E24\u6B65\u9A8C\u8BC1", `<div class="tf"><h1>\u6682\u4E0D\u53EF\u7528</h1><p>\u670D\u52A1\u7AEF\u8FD8\u6CA1\u914D\u7F6E\u597D\uFF08\u7F3A\u5C11 TOTP_KEY / D1\uFF09\u3002</p></div>`, 503);
  const now = Date.now(), sid = await sidOf(request), csrf = await csrfTfa(env, request);
  const row = await tfaRow(env), enabled = !!(row && row.enabled);
  const pend = await env.DB.prepare("SELECT * FROM totp_pending WHERE sid = ?1 AND exp > ?2").bind(sid, now).first().catch(() => null);
  const hid = `<input type="hidden" name="csrf" value="${escH(csrf)}">`;
  const render = (inner, st) => tfaHtml("\u4E24\u6B65\u9A8C\u8BC1", `<div class="tf">${inner}<hr><p style="font-size:13px"><a href="/">\u2190 \u8FD4\u56DE\u5DE5\u4F5C\u53F0</a></p></div>`, st);
  let msg = "", err = "";
  if (request.method === "POST") {
    const retry = pend && pend.kind === "enroll" && pend.code_h && !pend.email_ok ? "/2fa/setup?sent=1" : "/2fa/setup";
    const again = `<p><a class="tfa-retry" href="${retry}" style="display:inline-block;margin-top:8px;padding:12px 18px;border-radius:11px;background:linear-gradient(135deg,#5b8cff,#7a5cff);color:#fff;text-decoration:none;font-weight:600">\u21BB \u91CD\u65B0\u6253\u5F00\u672C\u9875\uFF08\u8FDB\u5EA6\u4FDD\u7559\uFF09</a></p>`;
    if (originState(request) === "bad") return render(`<p class="err">\u8BF7\u6C42\u6765\u6E90\u4E0D\u5BF9\uFF0C\u8BF7\u5237\u65B0\u9875\u9762\u91CD\u8BD5\u3002</p>${again}`, 403);
    let form;
    try {
      form = await request.formData();
    } catch (e) {
      return render(`<p class="err">\u9875\u9762\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u6253\u5F00\u3002</p>${again}`, 400);
    }
    if (!await ctEq(String(form.get("csrf") || ""), csrf)) return render(`<p class="err">\u9875\u9762\u5DF2\u8FC7\u671F\uFF08\u53EF\u80FD\u662F\u767B\u5F55\u72B6\u6001\u53D8\u4E86\uFF09\uFF0C\u70B9\u4E0B\u9762\u91CD\u65B0\u6253\u5F00\u3002</p>${again}`, 403);
    if (await tfaLocked(env, request, now)) return render(`<p class="err">\u5C1D\u8BD5\u8FC7\u4E8E\u9891\u7E41\uFF0C\u8BF7 15 \u5206\u949F\u540E\u518D\u8BD5\u3002</p>`, 429);
    const a = String(form.get("a") || "");
    if (a === "send" || a === "reset_send") {
      const kind = a === "send" ? "enroll" : "reset";
      if (kind === "enroll" && enabled) return Response.redirect(new URL("/2fa/setup", url), 303);
      if (kind === "reset" && !enabled) return Response.redirect(new URL("/2fa/setup", url), 303);
      if (pend && pend.sent_at && now - pend.sent_at < 6e4 && pend.kind === kind && (kind === "enroll" || pend.factor_ok)) err = "\u9A8C\u8BC1\u7801\u521A\u53D1\u8FC7\uFF0C\u8BF7 1 \u5206\u949F\u540E\u518D\u91CD\u53D1\u3002";
      else {
        if (kind === "reset") {
          let f = "";
          try {
            f = await tfaVerifyFactor(env, form.get("factor"), now);
          } catch (e) {
          }
          if (!f) {
            await tfaFailAdd(env, request, now);
            err = "\u5F53\u524D\u52A8\u6001\u7801 / \u6062\u590D\u7801\u4E0D\u5BF9\u6216\u5DF2\u7528\u8FC7\u3002";
          }
        }
        if (!err) {
          if (!await mailQuotaOk(env, now)) err = "\u8FD9\u4E00\u5C0F\u65F6\u53D1\u7684\u9A8C\u8BC1\u7801\u592A\u591A\u4E86\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5\u3002";
          else {
            const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1e6).padStart(6, "0");
            await env.DB.prepare("INSERT INTO totp_pending (sid, kind, code_h, code_exp, tries, sent_at, email_ok, factor_ok, secret_enc, exp) VALUES (?1, ?2, ?3, ?4, 0, ?5, 0, ?6, NULL, ?7) ON CONFLICT(sid) DO UPDATE SET kind = excluded.kind, code_h = excluded.code_h, code_exp = excluded.code_exp, tries = 0, sent_at = excluded.sent_at, email_ok = 0, factor_ok = excluded.factor_ok, secret_enc = NULL, exp = excluded.exp").bind(sid, kind, await tfaMac(env, "mail:" + sid + ":" + code), now + MAILCODE_TTL, now, kind === "reset" ? 1 : 0, now + 30 * 6e4).run();
            try {
              await mailSend(
                env,
                kind === "enroll" ? "[\u9762\u677F] \u7ED1\u5B9A\u4E24\u6B65\u9A8C\u8BC1\u7684\u90AE\u7BB1\u9A8C\u8BC1\u7801\uFF1A" + code : "[\u9762\u677F] \u91CD\u7F6E\u4E24\u6B65\u9A8C\u8BC1\u7684\u90AE\u7BB1\u9A8C\u8BC1\u7801\uFF1A" + code,
                [
                  (kind === "enroll" ? "\u6709\u4EBA\u6B63\u5728\u5DE5\u4F5C\u53F0\u7ED1\u5B9A\u4E24\u6B65\u9A8C\u8BC1\uFF08\u624B\u673A\u9A8C\u8BC1\u5668\uFF09\u3002" : "\u6709\u4EBA\u6B63\u5728\u5DE5\u4F5C\u53F0\u91CD\u7F6E\uFF08\u5173\u95ED\uFF09\u4E24\u6B65\u9A8C\u8BC1\u3002") + "\u9A8C\u8BC1\u7801\uFF1A",
                  "",
                  "    " + code,
                  "",
                  "20 \u5206\u949F\u5185\u6709\u6548\u3002",
                  "",
                  ...whoLines(request),
                  "",
                  "\u5982\u679C\u4E0D\u662F\u4F60\u672C\u4EBA\u5728\u64CD\u4F5C\uFF1A\u4E0D\u8981\u628A\u9A8C\u8BC1\u7801\u544A\u8BC9\u4EFB\u4F55\u4EBA\uFF0C\u5E76\u5C3D\u5FEB\u5728\u5DE5\u4F5C\u53F0\u70B9\u300C\u4E0B\u7EBF\u6240\u6709\u8BBE\u5907\u300D\u3001\u4FEE\u6539\u767B\u5F55\u5BC6\u7801\u3002"
                ],
                "2fa"
              );
              try {
                await adminLog(env, request, kind === "enroll" ? "totp_mail_enroll" : "totp_mail_reset");
              } catch (e) {
              }
              return Response.redirect(new URL("/2fa/setup?sent=1", url), 303);
            } catch (e) {
              console.log("2fa mail failed: " + String(e && e.message || e));
              err = "\u90AE\u4EF6\u53D1\u9001\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5\u3002";
            }
          }
        }
      }
    } else if (a === "email" || a === "pw") {
      const p2 = pend && pend.kind === "enroll" ? pend : null;
      if (!p2 || enabled) return Response.redirect(new URL("/2fa/setup", url), 303);
      const ok = a === "pw" ? await tfaPwCheck(env, request, form, now) : await mailCodeCheck(env, request, p2, sid, String(form.get("code") || ""), now);
      if (ok !== true) err = ok;
      else {
        try { await env.DB.prepare("UPDATE mail_outbox SET status = 'superseded', error = 'code no longer needed' WHERE kind = '2fa' AND status = 'pending'").run(); } catch (e) {}
        const secret = crypto.getRandomValues(new Uint8Array(20));
        await env.DB.prepare("UPDATE totp_pending SET email_ok = 1, code_h = NULL, secret_enc = ?2 WHERE sid = ?1").bind(sid, await tfaEnc(env, secret, "totp:pending:" + sid)).run();
        const b32 = b32enc(secret);
        const grp = b32.replace(/(.{4})/g, "$1 ").trim();
        return render(`<h1>\u7B2C 2 \u6B65\uFF1A\u626B\u7801\u7ED1\u5B9A</h1><ol><li>\u624B\u673A\u6253\u5F00 Google Authenticator \u6216 Microsoft Authenticator\uFF0C\u70B9\u300C+\u300D\u2192\u300C\u626B\u63CF\u4E8C\u7EF4\u7801\u300D\u3002</li><li>\u626B\u4E0B\u9762\u7684\u4E8C\u7EF4\u7801\uFF08\u626B\u4E0D\u4E86\u5C31\u9009\u300C\u8F93\u5165\u8BBE\u7F6E\u5BC6\u94A5\u300D\uFF0C\u624B\u52A8\u586B\u4E0B\u9762\u7684\u5BC6\u94A5\uFF0C\u7C7B\u578B\u9009\u300C\u57FA\u4E8E\u65F6\u95F4\u300D\uFF09\u3002</li><li>\u628A App \u91CC\u663E\u793A\u7684 6 \u4F4D\u6570\u5B57\u586B\u5230\u4E0B\u9762\uFF0C\u70B9\u300C\u786E\u8BA4\u7ED1\u5B9A\u300D\u3002</li></ol>
<div class="qr">${qrSvg(otpauthUri(b32))}</div><p style="text-align:center;margin:4px 0 6px;font-size:13px">\u624B\u52A8\u8F93\u5165\u7684\u5BC6\u94A5\uFF08\u8D26\u6237\u540D\u968F\u610F\uFF0C\u5982 ${escH(TFA_ISSUER)}\uFF09</p><div class="sec">${escH(grp)}</div>
<p class="warn" style="margin-top:14px">\u4E8C\u7EF4\u7801\u548C\u5BC6\u94A5<b>\u53EA\u663E\u793A\u8FD9\u4E00\u6B21</b>\uFF0C\u79BB\u5F00\u6216\u5237\u65B0\u672C\u9875\u540E\u4E0D\u4F1A\u518D\u663E\u793A\uFF08\u9700\u8981\u91CD\u65B0\u53D1\u90AE\u7BB1\u9A8C\u8BC1\u7801\u518D\u6765\u4E00\u904D\uFF09\u3002</p>
<form method="post" action="/2fa/setup" autocomplete="off">${hid}<input type="hidden" name="a" value="confirm"><input class="code" name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="000000" maxlength="7" required><button>\u786E\u8BA4\u7ED1\u5B9A</button></form>`);
      }
    } else if (a === "confirm") {
      const p2 = pend && pend.kind === "enroll" && pend.email_ok && pend.secret_enc ? pend : null;
      if (!p2 || enabled) return Response.redirect(new URL("/2fa/setup", url), 303);
      let secret;
      try {
        secret = await tfaDec(env, p2.secret_enc, "totp:pending:" + sid);
      } catch (e) {
        return render(`<p class="err">\u5185\u90E8\u9519\u8BEF\uFF0C\u8BF7\u91CD\u65B0\u5F00\u59CB\u3002</p>`, 500);
      }
      const step = await totpMatch(secret, form.get("code"), 0, now);
      if (step < 0) {
        await tfaFailAdd(env, request, now);
        await env.DB.prepare("UPDATE totp_pending SET tries = tries + 1 WHERE sid = ?1").bind(sid).run();
        if ((Number(p2.tries) || 0) + 1 >= MAILCODE_TRIES) {
          await env.DB.prepare("DELETE FROM totp_pending WHERE sid = ?1").bind(sid).run();
          err = "\u52A8\u6001\u7801\u8FDE\u7EED\u9519\u8BEF\uFF0C\u7ED1\u5B9A\u5DF2\u53D6\u6D88\uFF0C\u8BF7\u91CD\u65B0\u5F00\u59CB\uFF08\u68C0\u67E5\u624B\u673A\u65F6\u95F4\u662F\u5426\u51C6\u786E\uFF09\u3002";
        } else return render(`<h1>\u52A8\u6001\u7801\u4E0D\u5BF9</h1><p>\u8BF7\u786E\u8BA4\u624B\u673A\u65F6\u95F4\u662F\u81EA\u52A8\u540C\u6B65\u7684\uFF0C\u7B49 App \u91CC\u7684\u6570\u5B57\u5237\u65B0\u540E\u518D\u8BD5\u3002\u4E8C\u7EF4\u7801\u4E0D\u4F1A\u518D\u663E\u793A\uFF1B\u5982\u679C\u8FD8\u6CA1\u626B\u4E0A\uFF0C\u8BF7 <a href="/2fa/setup">\u91CD\u65B0\u5F00\u59CB</a>\u3002</p>
<form method="post" action="/2fa/setup" autocomplete="off">${hid}<input type="hidden" name="a" value="confirm"><input class="code" name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="000000" maxlength="7" required autofocus><button>\u786E\u8BA4\u7ED1\u5B9A</button></form>`);
      } else {
        const codes = Array.from({ length: 10 }, rcNew);
        const hs = await Promise.all(codes.map((c) => tfaMac(env, "rc:" + rcNorm(c))));
        const enc = await tfaEnc(env, secret, "totp:secret");
        await env.DB.batch([
          env.DB.prepare("INSERT INTO totp (id, secret_enc, enabled, last_step, created_at, updated_at) VALUES (1, ?1, 1, ?2, ?3, ?3) ON CONFLICT(id) DO UPDATE SET secret_enc = excluded.secret_enc, enabled = 1, last_step = excluded.last_step, created_at = excluded.created_at, updated_at = excluded.updated_at").bind(enc, step, now),
          env.DB.prepare("DELETE FROM totp_recovery"),
          ...hs.map((h) => env.DB.prepare("INSERT INTO totp_recovery (h, created_at, used_at) VALUES (?1, ?2, NULL)").bind(h, now)),
          env.DB.prepare("DELETE FROM totp_pending WHERE sid = ?1").bind(sid),
          // every other session (and AI-assistant cookie) is signed off; this browser gets a fresh cookie below
          env.DB.prepare("INSERT INTO sess_meta (id, ver, t) VALUES (1, 1, ?1) ON CONFLICT(id) DO UPDATE SET ver = ver + 1, t = excluded.t").bind(now)
        ]);
        SV = null;
        try {
          await adminLog(env, request, "totp_enroll");
        } catch (e) {
        }
        if (ctx && ctx.waitUntil) ctx.waitUntil(mailSend(env, "[\u9762\u677F] \u5DF2\u5F00\u542F\u4E24\u6B65\u9A8C\u8BC1", ["\u5DE5\u4F5C\u53F0 panel.example.com \u5DF2\u5F00\u542F\u4E24\u6B65\u9A8C\u8BC1\uFF1A\u4EE5\u540E\u767B\u5F55\u9700\u8981\u300C\u5BC6\u7801 + \u624B\u673A\u9A8C\u8BC1\u5668 6 \u4F4D\u52A8\u6001\u7801\u300D\u3002", "\u5DF2\u751F\u6210 10 \u4E2A\u4E00\u6B21\u6027\u6062\u590D\u7801\uFF08\u53EA\u5728\u7ED1\u5B9A\u9875\u9762\u663E\u793A\u8FC7\u4E00\u6B21\uFF09\u3002\u5176\u4ED6\u5DF2\u767B\u5F55\u7684\u8BBE\u5907\u5DF2\u5168\u90E8\u4E0B\u7EBF\u3002", "", ...whoLines(request), "", "\u5982\u679C\u4E0D\u662F\u4F60\u672C\u4EBA\u64CD\u4F5C\uFF0C\u8BF7\u7ACB\u523B\u68C0\u67E5\u4F60\u7684\u8D26\u6237\u3002"]).catch(() => {
        }));
        const txt = "panel.example.com \u5DE5\u4F5C\u53F0 \xB7 \u4E24\u6B65\u9A8C\u8BC1\u6062\u590D\u7801\r\n\u751F\u6210\u65F6\u95F4\uFF1A" + laFmt(now) + "\r\n\u6BCF\u4E2A\u53EA\u80FD\u7528\u4E00\u6B21\u3002\u624B\u673A\u4E22\u4E86 / \u9A8C\u8BC1\u5668\u5220\u4E86\u65F6\uFF0C\u5728\u52A8\u6001\u7801\u90A3\u4E00\u6B65\u8F93\u5165\u5176\u4E2D\u4E00\u4E2A\u5373\u53EF\u767B\u5F55\u3002\r\n\r\n" + codes.join("\r\n") + "\r\n";
        const res = render(`<h1 class="ok">\u2714 \u4E24\u6B65\u9A8C\u8BC1\u5DF2\u5F00\u542F</h1><p>\u4E0B\u9762\u662F <b>10 \u4E2A\u4E00\u6B21\u6027\u6062\u590D\u7801</b>\u3002\u624B\u673A\u4E22\u4E86\u6216\u9A8C\u8BC1\u5668\u88AB\u5220\u65F6\uFF0C\u5728\u8F93\u5165\u52A8\u6001\u7801\u90A3\u4E00\u6B65\u586B\u5176\u4E2D\u4E00\u4E2A\u5C31\u80FD\u767B\u5F55\uFF08\u6BCF\u4E2A\u53EA\u80FD\u7528\u4E00\u6B21\uFF09\u3002<b>\u53EA\u663E\u793A\u8FD9\u4E00\u6B21</b>\uFF0C\u8BF7\u73B0\u5728\u5C31\u4E0B\u8F7D\u6216\u590D\u5236\uFF0C\u5B58\u5230\u5BC6\u7801\u7BA1\u7406\u5668 / \u8BB0\u4E8B\u672C\u91CC\uFF08\u4E0D\u8981\u53EA\u5B58\u5728\u8FD9\u53F0\u624B\u673A\u4E0A\uFF09\u3002</p>
<div class="rc">${codes.map((c) => `<code>${escH(c)}</code>`).join("")}</div>
<div class="row"><button type="button" id="dl">\u4E0B\u8F7D .txt</button><button type="button" class="gh" id="cp">\u590D\u5236\u5168\u90E8</button></div><p id="st" class="ok" style="min-height:1.2em"></p>
<p class="warn">\u4E3A\u4E86\u5B89\u5168\uFF0C\u5176\u4ED6\u5DF2\u767B\u5F55\u7684\u8BBE\u5907\uFF08\u5305\u62EC AI \u52A9\u624B\uFF09\u90FD\u5DF2\u4E0B\u7EBF\uFF0C\u9700\u8981\u7528\u300C\u5BC6\u7801 + \u52A8\u6001\u7801\u300D\u91CD\u65B0\u767B\u5F55\uFF1B\u8FD9\u53F0\u8BBE\u5907\u4FDD\u6301\u767B\u5F55\u3002</p>
<script>(function(){var t=${JSON.stringify(txt)};var s=document.getElementById("st");document.getElementById("dl").onclick=function(){var a=document.createElement("a");a.href=URL.createObjectURL(new Blob([t],{type:"text/plain;charset=utf-8"}));a.download="\u5DE5\u4F5C\u53F0\u6062\u590D\u7801-panel.txt";document.body.appendChild(a);a.click();a.remove();s.textContent="\u5DF2\u4E0B\u8F7D";};document.getElementById("cp").onclick=function(){var ok=function(){s.textContent="\u5DF2\u590D\u5236\u5230\u526A\u8D34\u677F";};if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(ok,fb)}else fb();function fb(){var x=document.createElement("textarea");x.value=t;document.body.appendChild(x);x.select();try{document.execCommand("copy");ok();}catch(e){}x.remove();}};})();</script>`);
        res.headers.append("set-cookie", await gateCookieFor(env));
        return res;
      }
    } else if (a === "reset_confirm" || a === "reset_pw") {
      const p2 = pend && pend.kind === "reset" && pend.factor_ok ? pend : null;
      if (!p2 || !enabled) return Response.redirect(new URL("/2fa/setup", url), 303);
      const ok = a === "reset_pw" ? await tfaPwCheck(env, request, form, now) : await mailCodeCheck(env, request, p2, sid, String(form.get("code") || ""), now);
      if (ok !== true) err = ok;
      else {
        try { await env.DB.prepare("UPDATE mail_outbox SET status = 'superseded', error = 'code no longer needed' WHERE kind = '2fa' AND status = 'pending'").run(); } catch (e) {}
        await env.DB.batch([env.DB.prepare("DELETE FROM totp WHERE id = 1"), env.DB.prepare("DELETE FROM totp_recovery"), env.DB.prepare("DELETE FROM totp_pending WHERE sid = ?1").bind(sid)]);
        try {
          await adminLog(env, request, "totp_reset");
        } catch (e) {
        }
        if (ctx && ctx.waitUntil) ctx.waitUntil(mailSend(env, "[\u9762\u677F] \u4E24\u6B65\u9A8C\u8BC1\u5DF2\u5173\u95ED\uFF08\u91CD\u7F6E\uFF09", ["\u5DE5\u4F5C\u53F0 panel.example.com \u7684\u4E24\u6B65\u9A8C\u8BC1\u5DF2\u88AB\u91CD\u7F6E\uFF08\u5173\u95ED\uFF09\uFF0C\u65E7\u7684\u9A8C\u8BC1\u5668\u548C\u6062\u590D\u7801\u5168\u90E8\u4F5C\u5E9F\u3002\u73B0\u5728\u767B\u5F55\u53EA\u9700\u8981\u5BC6\u7801\uFF0C\u5DE5\u4F5C\u53F0\u9996\u9875\u4F1A\u63D0\u793A\u91CD\u65B0\u7ED1\u5B9A\u3002", "", ...whoLines(request), "", "\u5982\u679C\u4E0D\u662F\u4F60\u672C\u4EBA\u64CD\u4F5C\uFF1A\u7ACB\u523B\u70B9\u300C\u4E0B\u7EBF\u6240\u6709\u8BBE\u5907\u300D\u3001\u4FEE\u6539\u767B\u5F55\u5BC6\u7801\u5E76\u91CD\u65B0\u7ED1\u5B9A\u4E24\u6B65\u9A8C\u8BC1\u3002"]).catch(() => {
        }));
        msg = "\u4E24\u6B65\u9A8C\u8BC1\u5DF2\u91CD\u7F6E\uFF08\u5173\u95ED\uFF09\uFF0C\u65E7\u7684\u9A8C\u8BC1\u5668\u548C\u6062\u590D\u7801\u90FD\u5DF2\u4F5C\u5E9F\u3002\u53EF\u4EE5\u9A6C\u4E0A\u91CD\u65B0\u7ED1\u5B9A\u3002";
      }
    } else if (a === "cancel") {
      try { await env.DB.prepare("UPDATE mail_outbox SET status = 'superseded', error = 'code no longer needed' WHERE kind = '2fa' AND status = 'pending'").run(); } catch (e) {}
      await env.DB.prepare("DELETE FROM totp_pending WHERE sid = ?1").bind(sid).run();
      msg = "\u5DF2\u53D6\u6D88\u3002";
    }
  }
  const row2 = await tfaRow(env), on = !!(row2 && row2.enabled);
  const p3 = await env.DB.prepare("SELECT * FROM totp_pending WHERE sid = ?1 AND exp > ?2").bind(sid, Date.now()).first().catch(() => null);
  const sent = url.searchParams.get("sent") === "1" || request.method === "POST" && !!err && p3 && p3.code_h;
  const status = err ? `<p class="err">${escH(err)}</p>` : msg ? `<p class="ok">${escH(msg)}</p>` : "";
  if (!on) {
    if (p3 && p3.kind === "enroll" && p3.code_h && !p3.email_ok && (sent || err)) {
      return render(`<h1>\u7B2C 1 \u6B65\uFF1A\u90AE\u7BB1\u9A8C\u8BC1</h1>${status}<p>\u9A8C\u8BC1\u7801\u4F1A\u7531 noreply@example.com \u53D1\u5230\u4F60\u7684 Outlook\uFF0C\u4E00\u822C 5 \u5206\u949F\u5185\u5230\u8FBE\uFF08\u6536\u4EF6\u5730\u5740 ${escH(LA_TO.replace(/^(.{3}).*(@.*)$/, "$1\u2026$2"))}\uFF09\uFF0C\u9A8C\u8BC1\u7801 20 \u5206\u949F\u5185\u6709\u6548\u3002\u5EFA\u8BAE\u628A noreply@example.com \u52A0\u5165\u8054\u7CFB\u4EBA / \u5B89\u5168\u53D1\u4EF6\u4EBA\u3002\u786E\u8BA4\u662F\u4F60\u672C\u4EBA\u540E\u624D\u4F1A\u663E\u793A\u4E8C\u7EF4\u7801\u3002</p>${await tfaDeliveryHtml(env, p3)}
<form method="post" action="/2fa/setup" autocomplete="off">${hid}<input type="hidden" name="a" value="email"><input class="code" name="code" inputmode="numeric" placeholder="\u90AE\u7BB1\u9A8C\u8BC1\u7801" maxlength="7" required autofocus><button>\u4E0B\u4E00\u6B65</button></form>
<div class="row"><form method="post" action="/2fa/setup" style="flex:1">${hid}<input type="hidden" name="a" value="send"><button class="gh">\u91CD\u65B0\u53D1\u9001</button></form><form method="post" action="/2fa/setup" style="flex:1">${hid}<input type="hidden" name="a" value="cancel"><button class="gh">\u53D6\u6D88</button></form></div>${tfaPwForm(hid, "pw")}`);
    }
    return render(`<h1>\u5F00\u542F\u4E24\u6B65\u9A8C\u8BC1</h1>${status}<p>\u5F00\u542F\u540E\uFF0C\u767B\u5F55\u5DE5\u4F5C\u53F0\u9700\u8981\u300C\u5BC6\u7801 + \u624B\u673A\u9A8C\u8BC1\u5668\u91CC\u7684 6 \u4F4D\u52A8\u6001\u7801\u300D\u3002\u5C31\u7B97\u5BC6\u7801\u6CC4\u9732\uFF0C\u522B\u4EBA\u4E5F\u8FDB\u4E0D\u6765\u3002\u4EE3\u7406\u9762\u677F\u3001AI \u52A9\u624B\u3001\u7F51\u76D8\u7B49\u5B50\u9762\u677F\u4ECD\u7136\u514D\u5BC6\uFF08\u8DDF\u7740\u5DE5\u4F5C\u53F0\u767B\u5F55\u8D70\uFF09\u3002</p>
<ol><li>\u624B\u673A\u5148\u88C5\u597D <b>Google Authenticator</b> \u6216 <b>Microsoft Authenticator</b>\u3002</li><li>\u70B9\u4E0B\u9762\u6309\u94AE\uFF0C\u6211\u4EEC\u5F80\u4F60\u7684 Outlook \u53D1\u4E00\u4E2A 6 \u4F4D\u90AE\u7BB1\u9A8C\u8BC1\u7801\uFF08\u7531 noreply@example.com \u53D1\u51FA\uFF0C\u4E00\u822C 5 \u5206\u949F\u5185\u5230\u8FBE\uFF09\uFF08\u9632\u6B62\u522B\u4EBA\u7528\u4F60\u5DF2\u767B\u5F55\u7684\u6D4F\u89C8\u5668\u62A2\u5148\u7ED1\u5B9A\uFF09\uFF1B\u6536\u4E0D\u5230\u90AE\u4EF6\u65F6\u4E5F\u53EF\u4EE5\u6539\u7528\u767B\u5F55\u5BC6\u7801\u786E\u8BA4\u3002</li><li>\u586B\u90AE\u7BB1\u9A8C\u8BC1\u7801 \u2192 \u626B\u4E8C\u7EF4\u7801 \u2192 \u586B App \u91CC\u7684 6 \u4F4D\u6570\u5B57 \u2192 \u4FDD\u5B58 10 \u4E2A\u6062\u590D\u7801\u3002</li></ol>
<form method="post" action="/2fa/setup">${hid}<input type="hidden" name="a" value="send"><button>\u53D1\u9001\u90AE\u7BB1\u9A8C\u8BC1\u7801\uFF0C\u5F00\u59CB\u7ED1\u5B9A</button></form>`);
  }
  const left = await rcLeft(env);
  if (p3 && p3.kind === "reset" && p3.factor_ok && p3.code_h && (sent || err)) {
    return render(`<h1>\u91CD\u7F6E\u4E24\u6B65\u9A8C\u8BC1</h1>${status}<p>\u5F53\u524D\u52A8\u6001\u7801\u5DF2\u786E\u8BA4\u3002\u9A8C\u8BC1\u7801\u4F1A\u7531 noreply@example.com \u53D1\u5230\u4F60\u7684 Outlook\uFF0C\u4E00\u822C 5 \u5206\u949F\u5185\u5230\u8FBE\uFF0820 \u5206\u949F\u5185\u6709\u6548\uFF09\u3002\u586B\u5165\u540E\u4E24\u6B65\u9A8C\u8BC1\u4F1A\u88AB<b>\u5173\u95ED</b>\uFF0C\u65E7\u7684\u9A8C\u8BC1\u5668\u548C\u6062\u590D\u7801\u5168\u90E8\u4F5C\u5E9F\uFF0C\u4E4B\u540E\u53EF\u4EE5\u91CD\u65B0\u7ED1\u5B9A\u3002</p>
<form method="post" action="/2fa/setup" autocomplete="off">${hid}<input type="hidden" name="a" value="reset_confirm"><input class="code" name="code" inputmode="numeric" placeholder="\u90AE\u7BB1\u9A8C\u8BC1\u7801" maxlength="7" required autofocus><button class="dg">\u786E\u8BA4\u91CD\u7F6E</button></form>
<form method="post" action="/2fa/setup">${hid}<input type="hidden" name="a" value="cancel"><button class="gh">\u53D6\u6D88</button></form>${await tfaDeliveryHtml(env, p3)}${tfaPwForm(hid, "reset_pw")}`);
  }
  return render(`<h1 class="ok">\u2714 \u4E24\u6B65\u9A8C\u8BC1\u5DF2\u5F00\u542F</h1>${status}<p>\u5F00\u542F\u4E8E ${escH(laFmt(Number(row2.created_at) || 0))}\u3002\u5269\u4F59\u53EF\u7528\u6062\u590D\u7801\uFF1A<b>${left}</b> \u4E2A${left <= 3 ? "\uFF08\u5FEB\u7528\u5B8C\u4E86\uFF0C\u5EFA\u8BAE\u91CD\u7F6E\u540E\u91CD\u65B0\u7ED1\u5B9A\u4EE5\u751F\u6210\u65B0\u7684\u6062\u590D\u7801\uFF09" : ""}\u3002</p>
<hr><h2 style="font-size:18px;margin:0 0 6px">\u91CD\u7F6E\u4E24\u6B65\u9A8C\u8BC1</h2><p>\u6362\u624B\u673A\u3001\u9A8C\u8BC1\u5668\u4E22\u4E86\u65F6\u7528\u3002\u9700\u8981 <b>\u5F53\u524D\u52A8\u6001\u7801\u6216\u4E00\u4E2A\u6062\u590D\u7801</b>\uFF0C\u518D\u52A0 <b>\u90AE\u7BB1\u9A8C\u8BC1\u7801</b>\u3002\u91CD\u7F6E\u540E\u4E24\u6B65\u9A8C\u8BC1\u5173\u95ED\uFF0C\u53EF\u4EE5\u91CD\u65B0\u7ED1\u5B9A\u3002</p>
<form method="post" action="/2fa/setup" autocomplete="off">${hid}<input type="hidden" name="a" value="reset_send"><input class="code" name="factor" placeholder="\u52A8\u6001\u7801\u6216\u6062\u590D\u7801" maxlength="16" required><button class="dg">\u9A8C\u8BC1\u5E76\u53D1\u9001\u90AE\u7BB1\u9A8C\u8BC1\u7801</button></form>
<p style="font-size:13px">\u52A8\u6001\u7801\u548C\u6062\u590D\u7801\u90FD\u6CA1\u6709\u4E86\uFF1F\u8BF7\u8054\u7CFB\u7BA1\u7406\u5458\u5904\u7406\u3002</p>`);
}
// 2026-10-10: Outlook 拒收本域名发出的所有邮件（550 5.7.1 MailFrom domain is listed in Spamhaus）。MAIL.send() 成功只代表
// Cloudflare 收下，真正投递结果要查 Email Routing 日志（status worker /api/mail-delivery）。页面如实显示结果，并提供「登录密码确认」备用。
async function tfaDelivery(env, since) {
  if (!env.DB || !since) return { state: "unknown" };
  try {
    const r = await env.DB.prepare("SELECT id, status, sent_at, error FROM mail_outbox WHERE kind = '2fa' AND created_at >= ?1 ORDER BY id ASC LIMIT 1").bind(Number(since) - 2000).first();
    return r ? { state: r.status, at: r.sent_at, err: r.error } : { state: "unknown" };
  } catch (e) {
    return { state: "unknown" };
  }
}
async function tfaDeliveryHtml(env, p) {
  if (!p || !p.sent_at) return "";
  const d = await tfaDelivery(env, Number(p.sent_at));
  const again = ` <a href="/2fa/setup?sent=1">刷新状态</a>`;
  if (d.state === "sent") return `<p class="ok">✔ 已由 noreply@example.com 发出（${escH(laFmt(Number(d.at) || Date.now()))}）。收件箱没有的话，看看「其他」和垃圾邮件文件夹。</p>`;
  if (d.state === "pending") return `<p class="warn">⏳ 排队中：\u9A8C\u8BC1\u7801\u4F1A\u7531 noreply@example.com \u53D1\u5230\u4F60\u7684 Outlook\uFF0C\u4E00\u822C 5 \u5206\u949F\u5185\u5230\u8FBE。等不及可以直接用下面的「登录密码确认」。${again}</p>`;
  if (d.state === "failed" || d.state === "expired" || d.state === "superseded") return `<p class="err">✖ 这封验证码邮件没有发出（${escH(d.state)}）。请点「重新发送」，或用下面的「登录密码确认」。</p>`;
  return `<p class="warn">暂时查不到发送状态。\u9A8C\u8BC1\u7801\u4F1A\u7531 noreply@example.com \u53D1\u5230\u4F60\u7684 Outlook\uFF0C\u4E00\u822C 5 \u5206\u949F\u5185\u5230\u8FBE；收不到就用下面的「登录密码确认」。${again}</p>`;
}
function tfaPwForm(hid, a) {
  return `<hr><h2 style="font-size:18px;margin:0 0 6px">\u6536\u4E0D\u5230\u90AE\u4EF6\uFF1F\u7528\u767B\u5F55\u5BC6\u7801\u786E\u8BA4</h2><p>\u8F93\u5165\u5DE5\u4F5C\u53F0\u7684\u767B\u5F55\u5BC6\u7801\uFF0C\u4EE3\u66FF\u90AE\u7BB1\u9A8C\u8BC1\u7801\u786E\u8BA4\u662F\u4F60\u672C\u4EBA\u3002\u8F93\u9519\u4F1A\u8BA1\u5165\u5931\u8D25\u6B21\u6570\uFF0C\u8FDE\u7EED\u9519\u592A\u591A\u4F1A\u9501\u5B9A 15 \u5206\u949F\u3002</p>
<form method="post" action="/2fa/setup" autocomplete="off">${hid}<input type="hidden" name="a" value="${a}"><input type="password" name="password" autocomplete="current-password" placeholder="\u767B\u5F55\u5BC6\u7801" required><button${a === "reset_pw" ? ' class="dg"' : ""}>\u7528\u5BC6\u7801\u786E\u8BA4${a === "reset_pw" ? "\u91CD\u7F6E" : "\uFF0C\u4E0B\u4E00\u6B65"}</button></form>`;
}
async function tfaPwCheck(env, request, form, now) {
  const pw = form.get("password");
  if (env.PASSWORD && typeof pw === "string" && pw.length > 0 && await ctEq(pw, env.PASSWORD)) {
    try {
      await adminLog(env, request, "totp_pw_stepup");
    } catch (e) {
    }
    return true;
  }
  await tfaFailAdd(env, request, now);
  return "\u767B\u5F55\u5BC6\u7801\u4E0D\u5BF9\u3002";
}
async function mailCodeCheck(env, request, p, sid, code, now) {
  code = String(code || "").replace(/\s+/g, "");
  if (!p.code_h || now > Number(p.code_exp)) return "\u90AE\u7BB1\u9A8C\u8BC1\u7801\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u53D1\u9001\u3002";
  if ((Number(p.tries) || 0) >= MAILCODE_TRIES) return "\u9519\u8BEF\u6B21\u6570\u592A\u591A\uFF0C\u8BF7\u91CD\u65B0\u53D1\u9001\u9A8C\u8BC1\u7801\u3002";
  if (/^\d{6}$/.test(code) && await ctEq(await tfaMac(env, "mail:" + sid + ":" + code), p.code_h)) return true;
  await env.DB.prepare("UPDATE totp_pending SET tries = tries + 1 WHERE sid = ?1").bind(sid).run();
  await tfaFailAdd(env, request, now);
  return "\u90AE\u7BB1\u9A8C\u8BC1\u7801\u4E0D\u5BF9" + ((Number(p.tries) || 0) + 1 >= MAILCODE_TRIES ? "\uFF0C\u9519\u8BEF\u6B21\u6570\u592A\u591A\uFF0C\u8BF7\u91CD\u65B0\u53D1\u9001\u3002" : "\u3002");
}
export {
  buildLoginMime,
  portal_new_default as default,
  hotp,
  otpauthUri,
  qrSvg,
  totpMatch
};

// ======================= Batch B (2026-10): 只读访客 /g/<token> =======================
// Public, session-less. Token = 32 random bytes (base64url, 43 chars); D1 guest_invites stores SHA-256("guest1:" + token)
// only. Shows: the proxy subscription URL (+ copy, + inline SVG QR) and basic node status. Nothing else: no links to the
// workbench / admin / CFNext panel / drive / mail. Strict nonce CSP, no-store, noindex, no-referrer, DENY framing.
// Rate limits (D1 guest_rl, 10-minute windows): 60 views per invite, 20 invalid tokens per IP. Every view -> guest_views;
// first use of an invite -> email to the owner.
var G_WIN = 6e5, G_TOK_MAX = 60, G_BAD_MAX = 20;
async function gHash(tok) { return hexOf(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("guest1:" + tok))); }
async function gRl(env, k, inc) {
  const win = Math.floor(Date.now() / G_WIN);
  if (!inc) { const r = await env.DB.prepare("SELECT n FROM guest_rl WHERE k = ?1 AND win = ?2").bind(k, win).first(); return r ? Number(r.n) || 0 : 0; }
  const r = await env.DB.prepare("INSERT INTO guest_rl (k, win, n) VALUES (?1, ?2, 1) ON CONFLICT(k) DO UPDATE SET n = CASE WHEN guest_rl.win = ?2 THEN guest_rl.n + 1 ELSE 1 END, win = ?2 RETURNING n").bind(k, win).first();
  return r ? Number(r.n) || 0 : 0;
}
function gHeaders(nonce) {
  return { "content-type": "text/html; charset=utf-8", "cache-control": "no-store, private", "x-robots-tag": "noindex, nofollow, noarchive",
    "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src data:; connect-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
    "referrer-policy": "no-referrer", "x-frame-options": "DENY", "x-content-type-options": "nosniff", "cross-origin-opener-policy": "same-origin",
    "strict-transport-security": "max-age=31536000; includeSubDomains", "permissions-policy": "geolocation=(), microphone=(), camera=(), clipboard-read=()" };
}
var G_CSS = `:root{--bg:#09090b;--card:#18181b;--card2:#18181b;--line:#27272a;--txt:#fafafa;--muted:#a1a1aa;--brand:#8b5cf6;--brand2:#a78bfa;--ok:#22c55e;--warn:#eab308;--err:#ef4444}
*{box-sizing:border-box}body{margin:0;min-height:100vh;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:var(--txt);background:var(--bg);background-image:radial-gradient(ellipse 100% 80% at 50% -30%,rgba(139,92,246,0.1),transparent 50%)}
main{max-width:620px;margin:auto;padding:30px 18px 60px}.mark{letter-spacing:.12em;text-transform:uppercase;font-size:11px;font-weight:600;color:var(--muted);margin:0}h1{font-weight:600;font-size:24px;margin:6px 0 16px;letter-spacing:-0.02em}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;box-shadow:0 1px 3px 0 rgb(0 0 0 / 0.3);padding:18px;margin-bottom:14px}
h2{font-size:15px;margin:0 0 10px;font-weight:600}.muted{color:var(--muted)}.small{font-size:13px;line-height:1.55}
input{width:100%;background:var(--bg);color:var(--txt);border:1px solid var(--line);border-radius:8px;padding:10px 12px;font:13px ui-monospace,Menlo,Consolas,monospace}
button{margin-top:10px;border:0;background:var(--brand);color:#fff;border-radius:8px;padding:10px 14px;font:inherit;font-weight:500;cursor:pointer}
.qr{display:flex;justify-content:center;margin-top:14px}.qr svg{border-radius:8px;max-width:100%;height:auto}
.row{display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid var(--line);font-size:13px}.row:last-child{border-bottom:0}
.ok{color:var(--ok)}.bad{color:var(--err)}.warn{color:var(--warn)}
.note{border-left:3px solid var(--warn);background:rgba(234,179,8,0.08);padding:10px 12px;border-radius:6px;color:#fde68a;font-size:13px;line-height:1.55;margin:0 0 14px}
ol{padding-left:18px;margin:6px 0 0;line-height:1.7;font-size:13px}`;;
function gPage(nonce, title, inner, script, status) {
  const body = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow"><title>${escH(title)}</title><style nonce="${nonce}">${G_CSS}</style></head><body><main><p class="mark">代理订阅 · 访客</p>${inner}</main>${script ? `<script nonce="${nonce}">${script}</script>` : ""}</body></html>`;
  return new Response(body, { status: status || 200, headers: gHeaders(nonce) });
}
function gGone(nonce, status, msg) { return gPage(nonce, "链接无效", `<h1>链接无效或已失效</h1><div class="card"><p class="small muted">${escH(msg || "这个访客链接不存在、已过期或已被撤销。如果需要，请联系把链接发给你的人。")}</p></div>`, "", status); }
async function guestPage(request, env, ctx, url) {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("method not allowed", { status: 405, headers: { "allow": "GET", "cache-control": "no-store" } });
  if (!env.DB) return gGone(nonce, 503, "服务暂时不可用。");
  const tok = url.pathname.slice(3).replace(/\/+$/, "");
  const ip = request.headers.get("cf-connecting-ip") || "";
  try {
    if (await gRl(env, "bad:" + ip, false) >= G_BAD_MAX) return gGone(nonce, 429, "尝试次数太多，请 10 分钟后再试。");
    const row = /^[A-Za-z0-9_-]{40,64}$/.test(tok) ? await env.DB.prepare("SELECT id, name, expires_at, revoked_at, first_used_at, views FROM guest_invites WHERE token_h = ?1").bind(await gHash(tok)).first() : null;
    if (!row) { await gRl(env, "bad:" + ip, true); return gGone(nonce, 404); }
    const now = Date.now();
    if (row.revoked_at || Number(row.expires_at) <= now) return gGone(nonce, 410);
    if (await gRl(env, "tok:" + row.id, true) > G_TOK_MAX) return gGone(nonce, 429, "这个链接 10 分钟内打开太多次了，请稍后再试。");
    const co = request.cf && request.cf.country || "", ua = (request.headers.get("user-agent") || "").slice(0, 160);
    const first = !row.first_used_at;
    await env.DB.batch([
      env.DB.prepare("UPDATE guest_invites SET views = views + 1, last_used_at = ?2, last_ip = ?3, first_used_at = COALESCE(first_used_at, ?2) WHERE id = ?1").bind(row.id, now, ip),
      env.DB.prepare("INSERT INTO guest_views (t, gid, ip, co, ua) VALUES (?1, ?2, ?3, ?4, ?5)").bind(now, row.id, ip, co, ua)
    ]);
    if (first && ctx && ctx.waitUntil) ctx.waitUntil(mailSend(env, "[面板] 访客链接第一次被打开：" + row.name, ["你创建的访客邀请「" + row.name + "」（" + row.id + "）刚刚第一次被打开。", "", ...whoLines(request), "",
      "访客能看到：代理订阅链接 + 二维码、节点是否在线。看不到工作台和其它页面。", "提醒：访客拿到的是和你一样的订阅，撤销邀请不会自动换 UUID。", "管理 / 撤销：https://panel.example.com/admin/guests"], "guest").catch(e => console.log("guest mail failed: " + String(e && e.message || e))));
    // subscription + status
    const P = await panelPath(env);
    const sub = P ? "https://panel.example.com/" + P + "/sub" : "";
    let h = null, up = null, ph = null;
    try {
      const [a, b, c] = await env.DB.batch([
        env.DB.prepare("SELECT up, t FROM health WHERE svc = 'cfnext'"),
        env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(ok), 0) AS ok FROM health_log WHERE svc = 'cfnext' AND t >= ?1").bind(now - 7 * 864e5),
        env.DB.prepare("SELECT t, conclusion, samples FROM proxy_health WHERE id = 1")
      ]);
      h = (a.results || [])[0] || null; up = (b.results || [])[0] || null; ph = (c.results || [])[0] || null;
    } catch (e) {}
    let smp = []; try { smp = JSON.parse(ph && ph.samples || "[]"); } catch (e) {}
    const pct = up && up.n ? Math.round(up.ok / up.n * 1000) / 10 : null;
    const left = Math.max(0, Math.ceil((Number(row.expires_at) - now) / 864e5));
    const fmt8 = t => new Date(Number(t) + 288e5).toISOString().replace("T", " ").slice(0, 16);
    const nodeOk = smp.filter(x => x && x.ok).length;
    const stRows = `<div class="row"><span class="muted">代理服务</span><span>${h ? h.up ? `<b class="ok">● 在线</b>` : `<b class="bad">● 离线</b>` : `<span class="muted">未知</span>`}</span></div>
<div class="row"><span class="muted">近 7 天在线率</span><span>${pct == null ? "—" : `<b class="${pct >= 99 ? "ok" : pct >= 95 ? "warn" : "bad"}">${pct}%</b>`}</span></div>
<div class="row"><span class="muted">节点抽检（每小时）</span><span>${ph ? `${nodeOk} / ${smp.length} 个节点握手正常 · ${escH(fmt8(ph.t))}` : "—"}</span></div>`;
    const inner = `<h1>你好，${escH(row.name)}</h1>
<p class="note">这是主人分享给你的代理订阅，<b>请不要转发给别人</b>。链接 ${left} 天后（${escH(fmt8(row.expires_at))}，北京时间）失效；失效后已经导入的订阅可能也会被换掉。</p>
<div class="card"><h2>订阅链接</h2>${sub ? `<input id="s" type="text" readonly value="${escH(sub)}"><button id="c" type="button">复制订阅链接</button> <span id="cs" class="small muted"></span><div class="qr">${qrSvg(sub).replace('aria-label="\u4E24\u6B65\u9A8C\u8BC1\u4E8C\u7EF4\u7801"', 'aria-label="订阅二维码"')}</div>` : `<p class="bad">订阅暂时不可用，请稍后再试。</p>`}</div>
<div class="card"><h2>怎么用</h2><ol><li>手机（iPhone 用 Hako / Shadowrocket，安卓用 v2rayNG）或电脑（v2rayN / Clash Verge）里选「添加订阅」或「从剪贴板导入」。</li><li>粘贴上面的链接，或者用客户端扫二维码。</li><li>更新订阅后，选延迟最低的节点连接。</li></ol></div>
<div class="card"><h2>节点状态</h2>${stRows}<p class="small muted" style="margin-top:10px">状态每 5 分钟更新；节点速度请以客户端测速为准。</p></div>`;
    const script = sub ? `(function(){var b=document.getElementById('c'),i=document.getElementById('s'),s=document.getElementById('cs');b.addEventListener('click',function(){var ok=function(){s.textContent='已复制'};var no=function(){i.focus();i.select();s.textContent='请长按 / 手动复制'};if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(i.value).then(ok,no);else no();});})();` : "";
    return gPage(nonce, "代理订阅 · " + row.name, inner, script);
  } catch (e) { console.log("guest page error: " + String(e && e.message || e)); return gGone(nonce, 500, "出错了，请稍后再试。"); }
}

// ======================= Mail outbox (2026-10-10) =======================
// Outlook 拒收 Cloudflare send_email（发件域名进了 Spamhaus），所以所有提醒邮件不再走 MAIL binding，
// 而是写进 D1 mail_outbox（status = pending），由盒子上的 relay（/workspace/mailrelay/relay.py）每 ~5 分钟取出，
// 用 noreply@example.com 发到你的邮箱。
var OBX_SQL = "CREATE TABLE IF NOT EXISTS mail_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL, text TEXT NOT NULL, html TEXT, status TEXT NOT NULL DEFAULT 'pending', sent_at INTEGER, error TEXT)";
function obxB64d(s) {
  const bin = atob(String(s || "").replace(/\s+/g, ""));
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(u);
}
function obxParse(mime) {
  mime = String(mime || "");
  const i = mime.indexOf("\r\n\r\n");
  const head = i >= 0 ? mime.slice(0, i) : mime, body = i >= 0 ? mime.slice(i + 4) : "";
  const m = /^Subject: (.*)$/mi.exec(head);
  const subject = m ? m[1].trim().replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_, b) => obxB64d(b)) : "(无主题)";
  return { subject, text: /Content-Transfer-Encoding:\s*base64/i.test(head) ? obxB64d(body) : body };
}
async function outboxPut(env, kind, subject, text, html) {
  if (!env.DB) throw new Error("no DB binding");
  const ins = () => env.DB.prepare("INSERT INTO mail_outbox (created_at, kind, subject, text, html, status) VALUES (?1, ?2, ?3, ?4, ?5, 'pending') RETURNING id")
    .bind(Date.now(), String(kind || "alert").slice(0, 40), String(subject || "").slice(0, 300), String(text || "").slice(0, 20000), html ? String(html).slice(0, 60000) : null).first();
  let r;
  try { r = await ins(); }
  catch (e) {
    if (!/no such table/i.test(String(e && e.message || e))) throw e;
    await env.DB.prepare(OBX_SQL).run();
    r = await ins();
  }
  return r ? r.id : null;
}
async function outboxMime(env, kind, mime) {
  const p = obxParse(mime);
  return outboxPut(env, kind, p.subject, p.text, null);
}
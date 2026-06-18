const fs = require("fs/promises");
const path = require("path");

class PayinStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.ready = this.ensureFile();
  }

  async ensureFile() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });

    try {
      await fs.access(this.filePath);
    } catch {
      await fs.writeFile(this.filePath, "[]\n", "utf8");
    }
  }

  async all() {
    await this.ready;
    const raw = await fs.readFile(this.filePath, "utf8");
    return JSON.parse(raw || "[]");
  }

  async write(items) {
    await this.ready;
    await fs.writeFile(this.filePath, `${JSON.stringify(items, null, 2)}\n`, "utf8");
  }

  async create(payin) {
    const items = await this.all();
    items.push(payin);
    await this.write(items);
    return payin;
  }

  async findByRequestId(requestId) {
    const items = await this.all();
    return items.find((item) => item.requestId === requestId) || null;
  }

  async updateByRequestId(requestId, patch) {
    const items = await this.all();
    const index = items.findIndex((item) => item.requestId === requestId);

    if (index === -1) {
      return null;
    }

    items[index] = {
      ...items[index],
      ...patch,
      updatedAt: new Date().toISOString()
    };

    await this.write(items);
    return items[index];
  }
}

module.exports = { PayinStore };

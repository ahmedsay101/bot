class DB {
    constructor(collection) {
      this.collection = collection;
      this.properties = [];
    } 
  
    setProperties() {
      let properties = Object.getOwnPropertyNames(this);
      properties = properties.filter(property => !(this[property] instanceof Function));
      this.properties = properties.filter(name => name[0] === "_" && name !== "_id");
    }

    get(property) {
        return this[property];
    }

    async fromId(id) {
        try {
          this._id = id;
          await this.dbSync();
        }
        catch(error) {
          console.log(error);
        }
    }

    async dbSync() {
        try {
            this.setProperties();
            const data = {};
            for(let name of this.properties) {
                let isValid = false;
                const property = this[name];
                if(property && property !== "" && property !== null) isValid = true;
                if(Array.isArray(property) && property.length < 1) isValid = false;
                if(this.overwrite.includes(name.replace(/_/g, ""))) isValid = true;
                if(isValid) data[name.replace(/_/g, "")] = property;
            }  

            const doesExist = this._id !== null && this._id !== undefined;
              
            if(doesExist) {
                await this.collection.findByIdAndUpdate(this._id, data);
            }
            else {
                const response = await this.collection.create(data);
                if(response) this._id = response._id;
            }

            if(doesExist) {
                const results = await this.collection.findById(this._id).lean();
                const namesToUpdate = Object.keys(results).filter(key => this.properties.map(name => name.replace(/_/g, "")).includes(key));
                for(let property of namesToUpdate) {
                    this[`_${property}`] = (typeof results[property] === "number") ? Number(results[property]) : results[property];
                }
                this._updatedAt = new Date();
            }
        }
        catch(error) {
            console.log(error);
        }
    }

    async forceUpdate(data) {
        try {
            await this.collection.findByIdAndUpdate(this._id, data);
        }
        catch(error) {
            console.log(error);
        }
    }
};
  
module.exports = { DB };

import cors from "cors";
import express from "express";
import path from "path";
import { createClient, RedisClient } from "redis";
import "reflect-metadata";
import { createConnection, getConnection } from "typeorm";
import { __prod__ } from "./constants/constants";
import { User } from "./entities/User";

const main = async () => {
  require("dotenv").config();
  await createConnection({
    type: "postgres",
    url: process.env.DB_URL,
    logging: !__prod__,
    synchronize: !__prod__,
    migrations: [path.join(__dirname, "./migrations/*")],
    entities: [User],
    cli: { migrationsDir: "migrations" },
  });

  const redisCache = createClient({
    url: process.env.REDIS_URL,
  });
  const subscriberNotes = createClient({
    url: __prod__ ? process.env.PUBLISHER_NOTES_URL : process.env.REDIS_URL,
  });
  var bodyParser = require("body-parser");
  const app = express();
  app.use(bodyParser.urlencoded({ extended: false }));
  app.use(bodyParser.json());
  app.set("trust proxy", true);
  console.log("allowing CORS origin:", process.env.CORS_ORIGIN);
  app.use(
    cors({
      origin: process.env.CORS_ORIGIN,
      credentials: true,
      methods: ["POST", "GET", "DELETE", "PUT"],
      allowedHeaders: [
        "access-control-allow-origin",
        "authorization",
        "content-type",
      ],
    })
  );

  app.enable("trust proxy");

  function invalidateCache(redis: RedisClient): void {
    console.log("Invalidating cache...");
    redis.keys(`${process.env.REDIS_PREFIX}:*`, function (_err, keys) {
      keys.forEach(function (key) {
        redis.del(key);
      });
    });
  }

  subscriberNotes.on("message", async function (_channel, message) {
    console.log("Message: " + message);
    const data = JSON.parse(message);
    const user = await User.findOne(data["creatorId"]);
    if (!user) {
      console.log("No such user found");
    } else {
      if (data["method"] == "post") {
        user.noteIds.push(data["id"]);
      } else if (data["method"] == "delete") {
        const idArray = user.noteIds;
        const index = idArray.indexOf(data["id"]);
        if (index > -1) {
          idArray.splice(index, 1);
        }
        user.noteIds = idArray;
      }
      await user.save();
      invalidateCache(redisCache);
    }
  });

  app.post("/users", async (req, res) => {
    console.log(`Got POST on /users from gateway...`);
    let user;
    try {
      const result = await getConnection()
        .createQueryBuilder()
        .insert()
        .into(User)
        .values({
          username: req.body.username,
          email: req.body.email,
          password: req.body.password,
          profilePictureUrl: req.body.profilePictureUrl,
          logIds: [],
          categoryIds: [],
          noteIds: [],
        })
        .returning("*")
        .execute();
      user = result.raw[0];
    } catch (err) {
      res.send({ error: err.code });
      return;
    }
    console.log("Created new user");
    invalidateCache(redisCache);
    res.send({ user });
  });

  app.post("/me", async (req, res) => {
    const user = await User.findOne(req.body.id);
    res.send({ user });
  });

  app.post("/userByEmailUsername", async (req, res) => {
    const user = await User.findOne(
      req.body.usernameOrEmail.includes("@")
        ? { where: { email: req.body.usernameOrEmail } }
        : { where: { username: req.body.usernameOrEmail } }
    );
    if (!user) {
      res.send({ error: "no such user" });
    }
    res.send({ user });
  });

  app.post("/userById", async (req, res) => {
    const user = await User.findOne(req.body.id);
    if (!user) {
      res.send({ error: "no such user" });
    }
    res.send({ user });
  });

  app.put("/users", async (req, res) => {
    const user = await User.findOne(req.body.id);
    const password: string = req.body.password;
    user!.password = password;
    await user!.save();
    invalidateCache(redisCache);
    res.send({ user });
  });

  subscriberNotes.subscribe(process.env.NOTE_TOPIC as string);

  app.listen(parseInt(process.env.PORT!), () => {
    console.log(`Server started on port ${process.env.PORT}`);
  });
};

main().catch((err) => {
  console.error(err);
});

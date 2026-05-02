import { Schema, model, type InferSchemaType } from 'mongoose';

const UserSchema = new Schema(
  {
    username: { type: String, required: true, unique: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ['admin', 'viewer'], default: 'admin' },
    createdAt: { type: Date, default: () => new Date() },
  },
  { collection: 'users' },
);

export type UserDoc = InferSchemaType<typeof UserSchema>;
export const UserModel = model('User', UserSchema);

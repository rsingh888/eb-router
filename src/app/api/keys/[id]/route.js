import { NextResponse } from "next/server";
import { deleteApiKey, getApiKeyById, updateApiKey, toPublicApiKey } from "@/lib/localDb";
import { withAuthUser } from "@/lib/auth/runtimeUserContext.js";

export const GET = withAuthUser(async (_request, { params }, user) => {
  try {
    const { id } = await params;
    const key = await getApiKeyById(id, user.id);
    if (!key) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    return NextResponse.json({ key: toPublicApiKey(key) });
  } catch (error) {
    console.log("Error fetching key:", error);
    return NextResponse.json({ error: "Failed to fetch key" }, { status: 500 });
  }
});

export const PUT = withAuthUser(async (request, { params }, user) => {
  try {
    const { id } = await params;
    const body = await request.json();
    const { isActive } = body;

    const existing = await getApiKeyById(id, user.id);
    if (!existing) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    const updateData = {};
    if (isActive !== undefined) updateData.isActive = isActive;

    const updated = await updateApiKey(id, updateData, user.id);

    return NextResponse.json({ key: toPublicApiKey(updated) });
  } catch (error) {
    console.log("Error updating key:", error);
    return NextResponse.json({ error: "Failed to update key" }, { status: 500 });
  }
});

export const DELETE = withAuthUser(async (_request, { params }, user) => {
  try {
    const { id } = await params;

    const deleted = await deleteApiKey(id, user.id);
    if (!deleted) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    return NextResponse.json({ message: "Key deleted successfully" });
  } catch (error) {
    console.log("Error deleting key:", error);
    return NextResponse.json({ error: "Failed to delete key" }, { status: 500 });
  }
});

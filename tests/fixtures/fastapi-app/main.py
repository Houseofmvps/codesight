from fastapi import FastAPI
app = FastAPI()
@app.get("/users")
def get_users():
    return []
@app.post("/users")
def create_user():
    return {}
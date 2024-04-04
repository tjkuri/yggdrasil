# Journal
Need a file to keep track of why I chose to so certain things.
The front end repo mimir has its own version of this, trying to keep notes in the repo that best makes sense but occasionally some things are relavent to both (e.g., the addition of a new stat to track or a new sport to include, that overarching kind of thing will probably be thrown into Mimir's Journal.md)

## 04-03-2024
Short term todos:
1. Update to only re-request the status of games that are currently ongoing
2. Add better error handling, when i was trying to stand something up quickly didnt really do any of this. Dont want to crash, want to handle errors with grace

Long term todos:
1. Use a database to cache data instead of files. 
2. Related to the point above, but if we have a better way of storing data, we can add endpoints to fetch how succesful the existing predictions are.


## 03-21-2024
Going to add some functions to save and retrive from cache. The obvious solution is to add some databases solution but for now since im trying to go fast .json files will do. (maybe next time Ill start at the beginning of the sports season so Im not racing with the end of season)

## 03-17-2024
Going to try to use balldontlie api when available since its request limits are per minute not per month.
### Potential TODO's
- async/await works fine for now, but when getting 'myLine' for all the games in a game slows down because all the calls are sequential. In the future if this becomes an issue we should look at places where there are a lot of consecutive calls and swap it out for get/then/Promises architecture + whatever other changes might ensue.

## 03-16-2024
I think I may have done more work than needed. I think the odds endpoint does all the things the games endpoint does. So i dont think i need function to fetch from both. Silverlining the games endpoint doesnt count towards your request quota so i havent been eating into it yet.

## 03-15-2024
Starting with recommendations on over and under lines on NBA games. Looking at APIs that I can use.
* Promising:
    * not sure why yet but when I try to do `await axios.get()` these apis error out for me (api-sports.io didnt) but when i try `get(..).then(...)` this seems to work.
    * [odds-api](https://the-odds-api.com)
        * will probably use this to get games in a given day
    * [balldontlie](https://www.balldontlie.io/#introduction)
        * use this to get score from previous few games
* Looked at but passed on
    * [https://api-sports.io](https://api-sports.io)
        * Found that the documentation wasnt too helpful. In practice returns didnt exacly match the expected from docs. Docs also didnt make it clear when search params where required or not. Ultimately didnt have enough functionality to serve my needs, there seem to be other apis that are better set up and can do what this one does along with other things.
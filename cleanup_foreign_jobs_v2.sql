-- ROOK — close out existing foreign jobs already in the database
-- Restructured as an array-based check instead of one giant regex
-- string (which was getting truncated by the SQL editor's input
-- handling). Same logic as backend/matching.js's mentionsNonUsCountry:
-- positive longitude (Eastern Hemisphere) or location text naming a
-- foreign country/major foreign city. Closes rather than deletes -
-- reversible, matches archiveOldJobs.js's normal 90-day-closed
-- permanent-deletion timeline instead of deleting immediately.

update jobs
set status = 'closed'
where status = 'active'
  and id in (
    select jobs.id
    from jobs, unnest(array[
      'china','india','germany','united kingdom','canada','mexico',
      'brazil','france','japan','australia','singapore','spain','italy',
      'netherlands','switzerland','ireland','poland','sweden','belgium',
      'south korea','taiwan','hong kong','philippines','vietnam',
      'thailand','malaysia','indonesia','south africa','israel','turkey',
      'argentina','colombia','chile','portugal','austria','denmark',
      'norway','finland','czech republic','romania','hungary','greece',
      'new zealand','united arab emirates','saudi arabia','egypt','russia',
      'mumbai','bangalore','bengaluru','delhi','new delhi','hyderabad',
      'pune','chennai','gurgaon','gurugram','noida','kolkata',
      'shanghai','beijing','shenzhen','guangzhou','manila','jakarta',
      'kuala lumpur','bangkok','ho chi minh city','hanoi','seoul',
      'tokyo','osaka','sao paulo','mexico city','dubai','tel aviv'
    ]) as term
    where jobs.status = 'active'
      and (jobs.job_lng > 0 or jobs.location_raw ~* ('\y' || term || '\y'))
  );
